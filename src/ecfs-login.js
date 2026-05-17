/**
 * ecfs-login.js
 * 전자소송(ECFS) 포털 인증서 로그인 처리
 *
 * 전략 (v4 - AnySign4PC 활용):
 * 1. puppeteer-core로 Chrome을 headed(화면 표시) 모드로 실행
 * 2. ECFS 로그인 페이지 접속 후 인증서로그인 버튼 자동 클릭
 * 3. AnySign4PC가 팝업되면 사용자가 직접 인증서 선택 + 비밀번호 입력
 * 4. 로그인 성공 후 세션 쿠키 자동 추출 → 서버로 반환
 *
 * AnySign4PC가 사용자 PC에 설치되어 있어야 합니다.
 * (ECFS 사이트에서 자동 설치 안내)
 */

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const state = require("./state");
const { send, addLog } = require("./utils");

/** 시스템 Chrome 경로 탐색 (Windows) */
function _findChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);

  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

/** ECFS 로그인 페이지 URL */
const ECFS_LOGIN_URL =
  "https://ecfs.scourt.go.kr/psp/index.on?m=PSP101M01";

/** 로그인 완료 대기 타임아웃 (사용자가 직접 인증서 선택하므로 넉넉하게) */
const LOGIN_TIMEOUT_MS = 180_000;

/** 중복 로그인 방지 플래그 */
let _loginInProgress = false;

// ─────────────────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────────────────

/**
 * 서버에서 수신한 ecfs_login 메시지를 처리합니다.
 * headed Chrome을 열고 사용자가 AnySign4PC로 직접 인증서 로그인하면
 * 세션 쿠키를 자동 추출하여 서버에 전송합니다.
 *
 * @param {object} payload - { requestId, userId }
 */
async function handleEcfsLogin(payload) {
  const { requestId } = payload;

  addLog(`ECFS 로그인 payload: ${JSON.stringify(payload).substring(0, 300)}`, "info");

  if (_loginInProgress) {
    addLog("이전 로그인이 진행 중입니다. 요청 무시.", "warning");
    _sendResult(requestId, false, null, null, "이전 로그인이 진행 중입니다.");
    return;
  }
  _loginInProgress = true;

  let browser = null;

  try {
    addLog("전자소송 인증서 로그인 시작 (AnySign4PC 모드)...", "info");
    send("agent:efiling-status", { status: "processing", step: "ECFS 로그인 준비" });

    // ── Chrome 실행 (headed) ──
    const chromePath = _findChromePath();
    if (!chromePath) {
      const err = "Chrome 또는 Edge 브라우저를 찾을 수 없습니다. Chrome을 설치하세요.";
      addLog(err, "error");
      _sendResult(requestId, false, null, null, err);
      send("agent:efiling-status", { status: "error", error: err });
      return;
    }

    addLog(`브라우저 실행 (headed): ${chromePath}`, "info");
    const puppeteer = await import("puppeteer-core");

    browser = await puppeteer.default.launch({
      executablePath: chromePath,
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    addLog("브라우저 실행 완료 (headed)", "success");

    const page = await browser.newPage();

    // ── 페이지 이벤트 로깅 ──
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.length < 200) {
        addLog(`[콘솔] ${text.substring(0, 150)}`, "info");
      }
    });

    page.on("pageerror", (err) => {
      addLog(`[페이지에러] ${err.message.substring(0, 150)}`, "error");
    });

    // ECFS 다이얼로그(alert) 메시지 캡처 (에러 메시지 포착용)
    let lastDialogMessage = "";
    page.on("dialog", async (dialog) => {
      lastDialogMessage = dialog.message();
      addLog(
        `[다이얼로그 ${dialog.type()}] ${lastDialogMessage.substring(0, 100)}`,
        "info"
      );
      await dialog.accept();
    });

    // ── ECFS 로그인 페이지 접속 ──
    addLog(`ECFS 로그인 페이지 접속: ${ECFS_LOGIN_URL}`, "info");
    send("agent:efiling-status", { status: "processing", step: "로그인 페이지 접속" });

    await page.goto(ECFS_LOGIN_URL, {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });
    addLog("ECFS 페이지 로드 완료", "info");

    // ── WebSquare SPA 로드 대기 ──
    addLog("WebSquare SPA 로드 대기...", "info");
    try {
      await page.waitForFunction(
        () =>
          document.readyState === "complete" &&
          document.body &&
          document.body.innerText.length > 50,
        { timeout: 15_000 }
      );
    } catch {
      addLog("WebSquare 콘텐츠 로드 대기 초과, 계속 진행...", "warning");
    }

    // 페이지 완전 렌더링 대기
    await new Promise((r) => setTimeout(r, 3_000));

    // ── 인증서 로그인 버튼 자동 클릭 ──
    addLog("인증서 로그인 버튼 클릭 시도...", "info");
    send("agent:efiling-status", { status: "processing", step: "인증서 로그인 버튼 클릭" });

    const clicked = await _clickCertLoginButton(page);

    if (clicked.success) {
      addLog(`인증서 로그인 버튼 클릭 성공: ${clicked.method}`, "success");
    } else {
      addLog("인증서 로그인 버튼 자동 클릭 실패. 사용자가 직접 클릭해주세요.", "warning");
    }

    // ── AnySign4PC 인증서 선택 대기 ──
    send("agent:efiling-status", {
      status: "processing",
      step: "인증서 선택 대기 중 (AnySign4PC)",
    });
    addLog(
      "AnySign4PC 인증서 선택 대기 중... 사용자가 인증서를 선택하고 비밀번호를 입력하세요.",
      "info"
    );

    // 초기 쿠키 스냅샷 (로그인 전 상태)
    const initialCookies = await page.cookies();
    const initialCookieNames = new Set(
      initialCookies
        .filter((c) => c.domain.includes("scourt.go.kr"))
        .map((c) => c.name)
    );

    // ── 로그인 성공 대기 (폴링) ──
    const loginResult = await _waitForLoginCompletion(
      page,
      initialCookieNames,
      LOGIN_TIMEOUT_MS
    );

    if (!loginResult.success) {
      const errorMsg = lastDialogMessage || loginResult.error;
      addLog(`로그인 실패: ${errorMsg}`, "error");
      _sendResult(requestId, false, null, null, errorMsg);
      send("agent:efiling-status", { status: "error", error: errorMsg });
      await browser.close().catch(() => {});
      return;
    }

    addLog(`ECFS 로그인 성공 감지! (${loginResult.method})`, "success");

    // 세션 안정화 대기
    await new Promise((r) => setTimeout(r, 2_000));

    const cookies = await _extractCookies(page);
    const userName = await _extractUserName(page);

    _sendResult(requestId, true, cookies, userName, null);
    addLog(
      `쿠키 ${cookies.length}개 추출${userName ? ` (${userName})` : ""}`,
      "success"
    );
    send("agent:efiling-status", { status: "completed", step: "로그인 완료" });

    await browser.close().catch(() => {});
  } catch (err) {
    addLog(`ECFS 로그인 오류: ${err.message}`, "error");
    addLog(`스택: ${err.stack?.substring(0, 300)}`, "error");
    _sendResult(requestId, false, null, null, err.message);
    send("agent:efiling-status", { status: "error", error: err.message });

    if (browser) {
      await browser.close().catch(() => {});
    }
  } finally {
    _loginInProgress = false;
    addLog("로그인 프로세스 종료 (잠금 해제)", "info");
  }
}

// ─────────────────────────────────────────────────────────
// 헬퍼 함수
// ─────────────────────────────────────────────────────────

/**
 * ECFS 로그인 페이지에서 인증서 로그인 버튼을 클릭합니다.
 * 여러 방법을 시도하여 가장 먼저 성공하는 방법을 사용합니다.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<{success: boolean, method: string}>}
 */
async function _clickCertLoginButton(page) {
  return page.evaluate(() => {
    // 방법 1: WebSquare 함수 직접 호출
    try {
      if (typeof mf_pfwork_scwin !== "undefined" && mf_pfwork_scwin.btn_certLogin_onclick) {
        mf_pfwork_scwin.btn_certLogin_onclick();
        return { success: true, method: "scwin.btn_certLogin_onclick()" };
      }
    } catch (e) { /* fall through */ }

    // 방법 2: 버튼 텍스트로 탐색
    const allClickables = document.querySelectorAll(
      "button, a, [role='button'], input[type='button'], span[class*='btn'], div[class*='btn']"
    );
    for (const el of allClickables) {
      const text = (el.textContent || el.value || "").trim();
      if (text.includes("인증서") && (text.includes("로그인") || text.includes("Login"))) {
        el.click();
        return { success: true, method: `텍스트 클릭: "${text}"` };
      }
    }

    // 방법 3: WebSquare 버튼 ID 패턴
    const idCandidates = [
      "mf_pfwork_btn_certLogin",
      "btn_certLogin",
      "mf_pfwork_btn_cert",
      "mf_pfwork_btn_certlogin",
    ];
    for (const id of idCandidates) {
      const el = document.getElementById(id);
      if (el) {
        el.click();
        return { success: true, method: `ID 클릭: #${id}` };
      }
    }

    return { success: false, method: "버튼을 찾을 수 없음" };
  });
}

/**
 * 로그인 성공 완료를 폴링으로 대기합니다.
 * URL 변경, 쿠키 변화, DOM 변화를 1초 간격으로 체크합니다.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {Set<string>} initialCookieNames - 로그인 전 쿠키 이름 집합
 * @param {number} timeoutMs
 * @returns {Promise<{success: boolean, method?: string, error?: string}>}
 */
async function _waitForLoginCompletion(page, initialCookieNames, timeoutMs) {
  const startUrl = page.url();
  const startTime = Date.now();
  const CHECK_INTERVAL = 1_500;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL));

    // 브라우저 연결 확인
    try {
      if (!page.browser().isConnected()) {
        return { success: false, error: "브라우저가 닫혔습니다." };
      }
    } catch {
      return { success: false, error: "브라우저 연결이 끊어졌습니다." };
    }

    try {
      // 체크 1: URL 변경 (로그인 후 메인 페이지로 이동)
      const currentUrl = page.url();
      if (currentUrl !== startUrl && !currentUrl.includes("PSP101M01")) {
        return { success: true, method: `URL 변경: ${currentUrl.substring(0, 80)}` };
      }

      // 체크 2: 새로운 세션 쿠키 출현
      const currentCookies = await page.cookies();
      const scourtCookies = currentCookies.filter((c) =>
        c.domain.includes("scourt.go.kr")
      );
      const newCookies = scourtCookies.filter(
        (c) => !initialCookieNames.has(c.name)
      );
      if (newCookies.length > 0) {
        const names = newCookies.map((c) => c.name).join(", ");
        addLog(`새 쿠키 감지: ${names}`, "info");
        return { success: true, method: `새 쿠키: ${names}` };
      }

      // 체크 3: DOM에서 로그인 상태 감지
      const loggedIn = await page.evaluate(() => {
        // 로그아웃 버튼/링크가 보이면 로그인 성공
        const logoutEls = document.querySelectorAll(
          "[class*='logout'], [id*='logout'], [onclick*='logout'], [href*='logout']"
        );
        for (const el of logoutEls) {
          if (el.offsetWidth > 0 || el.offsetHeight > 0) return "logout_button";
        }

        // 사용자 이름 표시 영역
        const userSelectors = [
          "[class*='user_name']", "[class*='user_nm']",
          "[id*='userNm']", "[id*='userName']",
          ".login_info", "[class*='gnb_login'] span",
        ];
        for (const sel of userSelectors) {
          const el = document.querySelector(sel);
          const text = el?.textContent?.trim();
          if (text && text.length > 1 && text !== "환영합니다") return "user_name";
        }

        return null;
      });

      if (loggedIn) {
        return { success: true, method: `DOM 감지: ${loggedIn}` };
      }
    } catch (err) {
      // 페이지 네비게이션 중 evaluate 실패 가능 → 무시
      addLog(`로그인 체크 오류 (무시): ${err.message.substring(0, 60)}`, "info");
    }
  }

  return { success: false, error: "로그인 대기 시간 초과 (3분). 인증서 로그인을 완료해주세요." };
}

/**
 * 세션 쿠키 추출 (scourt.go.kr 도메인)
 * @param {import('puppeteer-core').Page} page
 */
async function _extractCookies(page) {
  const allCookies = await page.cookies();
  return allCookies
    .filter((c) => c.domain.includes("scourt.go.kr"))
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
}

/**
 * 로그인된 사용자 이름 추출 시도
 * @param {import('puppeteer-core').Page} page
 */
async function _extractUserName(page) {
  return page
    .evaluate(() => {
      const selectors = [
        "[class*='user_name']",
        "[class*='user_nm']",
        "[id*='userNm']",
        "[id*='userName']",
        ".login_info",
        "[class*='welcome']",
        "[class*='gnb_login'] span",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text && text.length > 1 && text !== "환영합니다") return text;
      }
      return null;
    })
    .catch(() => null);
}

/**
 * ecfs_login_result 메시지를 WebSocket으로 서버에 전송합니다.
 */
function _sendResult(requestId, success, cookies, userName, error) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    addLog("로그인 결과 전송 실패: 서버 연결이 끊어져 있습니다.", "error");
    return;
  }
  try {
    state.ws.send(
      JSON.stringify({
        type: "ecfs_login_result",
        userId: String(state.userId),
        payload: { requestId, success, cookies, userName, error },
      })
    );
    addLog(
      `결과 전송: ${success ? "성공" : "실패"}${error ? ` (${error.substring(0, 60)})` : ""}`,
      success ? "info" : "warning"
    );
  } catch (err) {
    addLog(`결과 전송 오류: ${err.message}`, "error");
  }
}

module.exports = { handleEcfsLogin };
