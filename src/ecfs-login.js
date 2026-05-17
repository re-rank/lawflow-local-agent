/**
 * ecfs-login.js
 * 전자소송(ECFS) 포털 인증서 자동 로그인 처리
 *
 * 전략 (v3 - AnySign4PC 완전 우회):
 * 1. puppeteer-core headless로 ECFS 로그인 페이지 접속
 * 2. 서버 인증서를 페이지에서 가져옴 (pspsoltn.SVR_CERT 또는 직접 조회)
 * 3. Node.js에서 CMS 서명(signVal) + VID 봉투(encVid) 생성 (ecfs-crypto.js)
 * 4. WebSquare DataMap에 값을 직접 설정하고 submission 실행
 * 5. 로그인 성공 시 세션 쿠키 추출 → 서버로 반환
 *
 * AnySign4PC(wss://localhost:10531)와의 WebSocket 통신을 완전히 생략하므로
 * 사용자 PC에 AnySign4PC가 없어도 동작합니다.
 *
 * NOTE: CloakBrowser는 봇 탐지 우회용 패치 Chromium이라 Windows에서 headless를
 * 지원하지 않음. ECFS는 정부 사이트로 봇 탐지가 없으므로 puppeteer-core +
 * 시스템 Chrome을 사용하여 완전한 headless 실행을 보장합니다.
 */

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const state = require("./state");
const { send, addLog } = require("./utils");
const { loadConfig } = require("./config");
const { createCmsSignedData, createVidEnvelope } = require("./ecfs-crypto");

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

/** 로그인 완료 대기 타임아웃 */
const LOGIN_TIMEOUT_MS = 90_000;

/** 중복 로그인 방지 플래그 */
let _loginInProgress = false;

// ─────────────────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────────────────

/**
 * 서버에서 수신한 ecfs_login 메시지를 처리합니다.
 * @param {object} payload - { requestId, userId }
 */
async function handleEcfsLogin(payload) {
  const { requestId } = payload;

  // 수신 payload 전체 로깅 (디버깅)
  addLog(`ECFS 로그인 payload: ${JSON.stringify(payload).substring(0, 300)}`, "info");

  // 중복 실행 방지
  if (_loginInProgress) {
    addLog("이전 로그인이 진행 중입니다. 요청 무시.", "warning");
    _sendResult(requestId, false, null, null, "이전 로그인이 진행 중입니다.");
    return;
  }
  _loginInProgress = true;

  let browser = null;

  try {
    // 인증서 사전 검증
    if (!state.certPath || !state.certPassword) {
      addLog("인증서가 설정되지 않았습니다.", "error");
      _sendResult(
        requestId, false, null, null,
        "인증서가 설정되지 않았습니다. 에이전트에서 인증서를 먼저 선택하세요."
      );
      send("agent:efiling-status", { status: "error", error: "인증서 미설정" });
      return;
    }

    if (!state.certKeyPath) {
      addLog("개인키 파일이 설정되지 않았습니다.", "error");
      _sendResult(requestId, false, null, null, "개인키 파일(signPri.key)이 없습니다.");
      send("agent:efiling-status", { status: "error", error: "개인키 미설정" });
      return;
    }

    addLog(`인증서: ${state.certPath}`, "info");
    addLog(`개인키: ${state.certKeyPath}`, "info");
    addLog("전자소송 인증서 자동 로그인 시작...", "info");
    send("agent:efiling-status", { status: "processing", step: "ECFS 자동 로그인" });

    // CMS 서명 사전 테스트 (인증서/비밀번호 유효성 검증)
    addLog("인증서 유효성 검증 중...", "info");
    try {
      createCmsSignedData("TEST");
      addLog("인증서 유효성 검증 통과", "success");
    } catch (cryptoErr) {
      addLog(`인증서 암호화 실패: ${cryptoErr.message}`, "error");
      addLog(`스택: ${cryptoErr.stack?.substring(0, 500)}`, "error");
      _sendResult(
        requestId, false, null, null,
        `인증서 또는 비밀번호가 올바르지 않습니다: ${cryptoErr.message}`
      );
      send("agent:efiling-status", { status: "error", error: "인증서 검증 실패" });
      return;
    }

    // puppeteer-core + 시스템 Chrome (완전 headless)
    const chromePath = _findChromePath();
    if (!chromePath) {
      const err = "Chrome 또는 Edge 브라우저를 찾을 수 없습니다. Chrome을 설치하세요.";
      addLog(err, "error");
      _sendResult(requestId, false, null, null, err);
      send("agent:efiling-status", { status: "error", error: err });
      return;
    }

    addLog(`브라우저 실행 중 (headless): ${chromePath}`, "info");
    const puppeteer = await import("puppeteer-core");

    browser = await puppeteer.default.launch({
      executablePath: chromePath,
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
      ],
    });
    addLog("브라우저 실행 완료 (headless)", "success");

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

    page.on("dialog", async (dialog) => {
      addLog(
        `[다이얼로그 ${dialog.type()}] ${dialog.message().substring(0, 100)}`,
        "info"
      );
      await dialog.dismiss();
    });

    // ── 네트워크 인터셉트: AnySign4PC localhost 요청 차단 ──
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      if (/^(wss?|https?):\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(url)) {
        addLog(`[차단] localhost 요청: ${url.substring(0, 80)}`, "info");
        if (req.method() === "OPTIONS") {
          req.respond({
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
              "Access-Control-Allow-Headers": "*",
            },
          });
        } else {
          req.respond({
            status: 200,
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({
              result: 0,
              code: "0000",
              message: "success",
              status: "ready",
            }),
          });
        }
      } else {
        req.continue();
      }
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

    // onpageload 완료 대기 (서버 인증서 조회 등)
    await new Promise((r) => setTimeout(r, 8_000));

    // ── WebSquare 객체 존재 확인 ──
    const scopeCheck = await page.evaluate(() => ({
      hasScwin: !!window.mf_pfwork_scwin,
      hasDma: !!window.mf_pfwork_dma_certparam,
      hasSbm: !!window.mf_pfwork_sbm_certlogin,
      hasInput: !!window.mf_pfwork_ibx_elpUserIdForCert,
      hasSvrCert: !!(window.mf_pfwork_scwin && window.mf_pfwork_scwin._svr_cert),
      pageUrl: location.href,
      bodyLen: document.body ? document.body.innerText.length : 0,
    }));

    addLog(`WebSquare 스코프: scwin=${scopeCheck.hasScwin} dma=${scopeCheck.hasDma} sbm=${scopeCheck.hasSbm} input=${scopeCheck.hasInput} svrCert=${scopeCheck.hasSvrCert}`, "info");
    addLog(`페이지: ${scopeCheck.pageUrl} (본문길이: ${scopeCheck.bodyLen})`, "info");

    // ── Step 1: 서버 인증서 추출 (브라우저에서) ──
    addLog("서버 인증서 확보 중...", "info");
    send("agent:efiling-status", { status: "processing", step: "서버 인증서 확보" });

    const svrCertResult = await page.evaluate(async () => {
      const log = [];
      const scwin = window.mf_pfwork_scwin;

      if (!scwin) return { svrCert: null, error: "scwin 객체를 찾을 수 없습니다 (WebSquare 로드 실패)", log };

      let svrCert = null;

      // 방법 1: scwin._svr_cert
      try {
        svrCert = scwin._svr_cert;
        if (svrCert) log.push("서버인증서: scwin._svr_cert 사용");
      } catch (e) {
        log.push("scwin._svr_cert 접근 실패: " + e.message);
      }

      // 방법 2: pspsoltn.SVR_CERT
      if (!svrCert) {
        try {
          if (typeof pspsoltn !== "undefined" && pspsoltn.SVR_CERT) {
            svrCert = pspsoltn.SVR_CERT;
            log.push("서버인증서: pspsoltn.SVR_CERT 사용");
          }
        } catch (e) {
          log.push("pspsoltn.SVR_CERT 접근 실패: " + e.message);
        }
      }

      // 방법 3: API 직접 조회
      if (!svrCert) {
        log.push("서버 인증서 직접 조회 시도...");
        try {
          const resp = await fetch("/psp/psp001/svrcert.on", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dma_null: {} }),
          });
          const data = await resp.json();
          if (data?.data?.dma_svrcert?.respCode === "00") {
            eval(data.data.dma_svrcert.svrcert);
            svrCert = typeof svrcert !== "undefined" ? svrcert : null;
            log.push("서버인증서: 직접 조회 성공");
          } else {
            log.push("서버인증서 조회 응답: " + JSON.stringify(data?.data?.dma_svrcert));
          }
        } catch (e) {
          log.push("서버인증서 조회 실패: " + e.message);
        }
      }

      if (svrCert) log.push("서버인증서 확보 (길이: " + String(svrCert).length + ")");
      return { svrCert, log };
    });

    // 서버 인증서 추출 로그
    if (svrCertResult.log) {
      svrCertResult.log.forEach((l) => addLog(`  [인증서] ${l}`, "info"));
    }

    if (!svrCertResult.svrCert) {
      const errMsg = svrCertResult.error || "서버 인증서를 조회할 수 없습니다.";
      addLog(`서버 인증서 확보 실패: ${errMsg}`, "error");
      _sendResult(requestId, false, null, null, errMsg);
      send("agent:efiling-status", { status: "error", error: errMsg });
      await browser.close().catch(() => {});
      return;
    }

    // ── Step 2: Node.js에서 CMS 서명 + VID 봉투 생성 ──
    addLog("CMS 서명 + VID 봉투 생성 중...", "info");
    send("agent:efiling-status", { status: "processing", step: "인증서 서명 생성" });

    let signVal, encVid;
    try {
      signVal = createCmsSignedData("SCMAIN");
      addLog(`CMS 서명 완료 (길이: ${signVal.length})`, "success");
    } catch (cmsErr) {
      addLog(`CMS 서명 실패: ${cmsErr.message}`, "error");
      _sendResult(requestId, false, null, null, `CMS 서명 실패: ${cmsErr.message}`);
      send("agent:efiling-status", { status: "error", error: "CMS 서명 실패" });
      await browser.close().catch(() => {});
      return;
    }

    try {
      encVid = createVidEnvelope(String(svrCertResult.svrCert));
      addLog(`VID 봉투 완료 (길이: ${encVid.length})`, "success");
    } catch (vidErr) {
      addLog(`VID 봉투 실패: ${vidErr.message}`, "error");
      _sendResult(requestId, false, null, null, `VID 봉투 실패: ${vidErr.message}`);
      send("agent:efiling-status", { status: "error", error: "VID 봉투 실패" });
      await browser.close().catch(() => {});
      return;
    }

    // ── Step 3: DataMap 주입 + 로그인 submission 실행 ──
    addLog("로그인 데이터 주입 및 제출...", "info");
    send("agent:efiling-status", { status: "processing", step: "로그인 실행" });

    // ECFS 사용자 ID: payload에서 제공되면 사용, 없으면 config의 email(실제 로그인 아이디) 사용
    const cfg = loadConfig();
    const ecfsUserId = payload.ecfsUserId || payload.loginId || cfg.email || state.userId || "";
    addLog(`ECFS 사용자ID: "${ecfsUserId}" (config.email: ${cfg.email || "없음"})`, "info");

    // submission HTTP 요청 모니터링
    let submissionRequestSent = false;
    let submissionResponseReceived = false;
    let submissionUrl = "";
    page.on("response", (res) => {
      const url = res.url();
      if (url.includes("certlogin") || url.includes("psp001") || url.includes("login")) {
        submissionResponseReceived = true;
        submissionUrl = url;
        addLog(`[응답] ${res.status()} ${url.substring(0, 100)}`, "info");
      }
    });

    const execResult = await page.evaluate(async (userId, signValArg, encVidArg) => {
      const log = [];

      try {
        // Submission URL 확보 (WebSquare sbm 객체에서 추출)
        let actionUrl = "/psp/psp001/certlogin.on";
        try {
          const sbm = window.mf_pfwork_sbm_certlogin;
          if (sbm) {
            // WebSquare submission의 action 속성 탐색
            const possibleAction = sbm.action || sbm._action || sbm.getAttribute?.("action");
            if (possibleAction) {
              actionUrl = possibleAction;
              log.push("submission URL: " + actionUrl);
            } else {
              log.push("submission action 미발견, 기본 URL 사용");
            }
          }
        } catch (e) {
          log.push("sbm 탐색 실패: " + e.message);
        }

        // 요청 데이터 구성
        const clientTime = new Date().toISOString().replace("T", " ").split(".")[0];
        let uuid;
        try { uuid = crypto.randomUUID(); } catch { uuid = String(Date.now()); }

        const requestBody = {
          data: {
            dma_certparam: {
              elpUserId: userId.trim(),
              signVal: signValArg,
              encVid: encVidArg,
              loginType: "P",
              clientTime: clientTime,
              uuid: uuid,
            }
          }
        };

        log.push(`직접 POST 실행: ${actionUrl} (userId: ${userId.trim()})`);

        // 직접 fetch로 로그인 요청 전송
        const resp = await fetch(actionUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify(requestBody),
          credentials: "include",
        });

        log.push(`응답 상태: ${resp.status}`);

        if (!resp.ok) {
          return {
            phase: "http",
            success: false,
            error: `HTTP ${resp.status}: ${resp.statusText}`,
            log,
          };
        }

        const respData = await resp.json();
        log.push(`응답 데이터: ${JSON.stringify(respData).substring(0, 200)}`);

        // 서버 응답 결과 저장
        window.__ecfsLoginResult = respData;
        window.__ecfsLoginError = null;

        return { phase: "submitted", success: true, log };
      } catch (err) {
        return { phase: "fetch", success: false, error: err.message, log };
      }
    }, ecfsUserId, signVal, encVid);

    // 실행 결과 로깅
    if (execResult.log) {
      execResult.log.forEach((l) => addLog(`  [로그인] ${l}`, "info"));
    }

    if (!execResult.success) {
      const execLogs = (execResult.log || []).join(" → ");
      addLog(`로그인 실행 실패 (${execResult.phase}): ${execResult.error}`, "error");
      _sendResult(requestId, false, null, null, `[${execResult.phase}] ${execResult.error} (${execLogs})`);
      send("agent:efiling-status", { status: "error", error: execResult.error });
      await browser.close().catch(() => {});
      return;
    }

    // ── 로그인 결과 대기 ──
    const execLogs = (execResult.log || []).join(" → ");
    addLog(`로그인 실행 성공: ${execLogs}`, "info");

    // 직접 fetch 방식에서는 결과가 즉시 저장됨 (waitForFunction 불필요)
    // 만약 결과가 아직 없으면 짧은 대기
    try {
      await page.waitForFunction(
        () => window.__ecfsLoginResult !== null || window.__ecfsLoginError !== null,
        { timeout: 10_000 }
      );
    } catch {
      addLog("로그인 응답 대기 시간 초과 (10초)", "error");
      _sendResult(requestId, false, null, null, "로그인 응답을 받지 못했습니다.");
      send("agent:efiling-status", { status: "error", error: "응답 대기 시간 초과" });
      await browser.close().catch(() => {});
      return;
    }

    // ── 로그인 결과 처리 ──
    const loginResult = await page.evaluate(() => ({
      result: window.__ecfsLoginResult,
      error: window.__ecfsLoginError,
    }));

    if (loginResult.error) {
      addLog(`로그인 에러: ${loginResult.error}`, "error");
      _sendResult(requestId, false, null, null, loginResult.error);
      send("agent:efiling-status", { status: "error", error: loginResult.error });
      await browser.close().catch(() => {});
      return;
    }

    const serverResp = loginResult.result;
    addLog(`서버 응답: ${JSON.stringify(serverResp).substring(0, 200)}`, "info");

    const respCode = serverResp?.data?.respCode;
    const respMesg = serverResp?.data?.respMesg || "";

    if (respCode === "00") {
      // 로그인 성공
      addLog("ECFS 로그인 성공!", "success");

      // 세션 안정화 대기 (processCertLoginDone 내부 처리 완료)
      await new Promise((r) => setTimeout(r, 2_000));

      const cookies = await _extractCookies(page);
      const userName = await _extractUserName(page);

      _sendResult(requestId, true, cookies, userName, null);
      addLog(
        `쿠키 ${cookies.length}개 추출${userName ? ` (${userName})` : ""}`,
        "success"
      );
      send("agent:efiling-status", { status: "completed", step: "로그인 완료" });
    } else {
      // 로그인 실패 (서버에서 거부)
      addLog(`로그인 거부: [${respCode}] ${respMesg}`, "error");
      _sendResult(requestId, false, null, null, `서버 응답: ${respMesg}`);
      send("agent:efiling-status", { status: "error", error: respMesg });
    }

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
