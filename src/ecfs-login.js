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

    // ECFS 사용자 ID: payload에서 제공되면 사용, 없으면 state.userId 사용
    const ecfsUserId = payload.ecfsUserId || payload.loginId || state.userId || "";
    addLog(`ECFS 사용자ID: "${ecfsUserId}"`, "info");

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

    const execResult = await page.evaluate((userId, signValArg, encVidArg) => {
      const log = [];

      const scwin = window.mf_pfwork_scwin;
      const dma = window.mf_pfwork_dma_certparam;
      const sbm = window.mf_pfwork_sbm_certlogin;
      const idInput = window.mf_pfwork_ibx_elpUserIdForCert;

      if (!scwin) return { phase: "init", success: false, error: "scwin 객체를 찾을 수 없습니다", log };
      if (!dma) return { phase: "init", success: false, error: "dma_certparam DataMap을 찾을 수 없습니다", log };
      if (!sbm) return { phase: "init", success: false, error: "sbm_certlogin Submission을 찾을 수 없습니다", log };

      try {
        // 콜백 오버라이드 (결과 캡처)
        window.__ecfsLoginResult = null;
        window.__ecfsLoginError = null;

        try {
          const origDone = scwin.processCertLoginDone;
          scwin.processCertLoginDone = function (e) {
            try {
              const r = JSON.parse(e.responseText);
              window.__ecfsLoginResult = r;
            } catch (parseErr) {
              window.__ecfsLoginError = "응답 파싱 실패: " + parseErr.message;
            }
            try { origDone.call(this, e); } catch {}
          };
          log.push("콜백 오버라이드 완료");
        } catch (e) {
          log.push("콜백 오버라이드 실패 (비치명적): " + e.message);
        }

        // 아이디 입력
        try {
          if (idInput && typeof idInput.setValue === "function") {
            idInput.setValue(userId.trim());
          }
          dma.set("elpUserId", userId.trim());
          log.push("아이디 설정: " + userId.trim());
        } catch (e) {
          return { phase: "userid", success: false, error: "아이디 설정 실패: " + e.message, log };
        }

        // DataMap에 서명 데이터 설정
        try {
          dma.set("signVal", signValArg);
          dma.set("encVid", encVidArg);
          dma.set("loginType", "P");
          dma.set("clientTime", new Date().toISOString().replace("T", " ").split(".")[0]);
          try {
            dma.set("uuid", crypto.randomUUID());
          } catch {
            dma.set("uuid", String(Date.now()));
          }
          log.push("DataMap 설정 완료");
        } catch (e) {
          return { phase: "datamap", success: false, error: "DataMap 설정 실패: " + e.message, log };
        }

        // Submission 실행
        log.push("sbm_certlogin 실행...");
        try {
          const scope = typeof gcm !== "undefined" && gcm._getScope
            ? gcm._getScope("mf_pfwork") : null;
          const scopeP = scope && scope.$p;

          if (scopeP && typeof scopeP.executeSubmission === "function") {
            scopeP.executeSubmission(sbm);
            log.push("submission 전송됨 (gcm scope.$p)");
          } else if (typeof $p !== "undefined" && typeof $p.executeSubmission === "function") {
            $p.executeSubmission(sbm);
            log.push("submission 전송됨 ($p)");
          } else if (typeof com !== "undefined" && typeof com.executeSubmission === "function") {
            com.executeSubmission(sbm);
            log.push("submission 전송됨 (com)");
          } else if (typeof sbm.execute === "function") {
            sbm.execute();
            log.push("submission 전송됨 (sbm.execute)");
          } else {
            return { phase: "submit", success: false, error: "Submission 실행 방법을 찾을 수 없습니다.", log };
          }
        } catch (e) {
          return { phase: "submit", success: false, error: "Submission 실행 실패: " + e.message, log };
        }

        return { phase: "submitted", success: true, log };
      } catch (err) {
        return { phase: "unknown", success: false, error: err.message, log };
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

    try {
      await page.waitForFunction(
        () => window.__ecfsLoginResult !== null || window.__ecfsLoginError !== null,
        { timeout: LOGIN_TIMEOUT_MS }
      );
    } catch {
      // 타임아웃 - 페이지 상태 + 디버그 정보 수집
      const finalState = await page
        .evaluate(() => ({
          url: location.href,
          text: document.body
            ? document.body.innerText.replace(/\s+/g, " ").trim().substring(0, 500)
            : "",
          result: window.__ecfsLoginResult,
          error: window.__ecfsLoginError,
          hasScwin: !!window.mf_pfwork_scwin,
          hasDma: !!window.mf_pfwork_dma_certparam,
          dmaKeys: (() => {
            try {
              const d = window.mf_pfwork_dma_certparam;
              return d ? Object.keys(d._data || d.data || {}).join(",") : "N/A";
            } catch { return "에러"; }
          })(),
        }))
        .catch(() => ({ url: "?", text: "(추출 실패)" }));

      addLog(`로그인 응답 대기 시간 초과. URL: ${finalState.url}`, "error");
      addLog(`HTTP요청전송=${submissionResponseReceived}, URL=${submissionUrl}`, "info");
      addLog(`scwin=${finalState.hasScwin}, dma=${finalState.hasDma}, dmaKeys=${finalState.dmaKeys}`, "info");
      addLog(`페이지: ${finalState.text.substring(0, 200)}`, "info");

      // 타임아웃이어도 로그인 성공했을 수 있음 (콜백이 호출되지 않은 경우)
      if (
        finalState.text.includes("로그아웃") ||
        finalState.text.includes("마이페이지")
      ) {
        addLog("로그인 성공 감지 (텍스트 기반)", "success");
        const cookies = await _extractCookies(page);
        _sendResult(requestId, true, cookies, null, null);
        send("agent:efiling-status", { status: "completed", step: "로그인 완료" });
        await browser.close().catch(() => {});
        return;
      }

      const debugInfo = `scwin=${finalState.hasScwin},dma=${finalState.hasDma},httpSent=${submissionResponseReceived}`;
      _sendResult(
        requestId, false, null, null,
        `로그인 응답 대기 시간 초과 [${debugInfo}]. 페이지: ${finalState.text.substring(0, 150)}`
      );
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
