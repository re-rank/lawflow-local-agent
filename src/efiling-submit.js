/**
 * efiling-submit.js
 * 전자소송(ECFS) 포털 Puppeteer 자동화 처리
 * 서버에서 efiling_submit 메시지를 수신하면 브라우저를 열어 서류 제출을 지원합니다.
 *
 * 로그인은 에이전트에 설정된 인증서로 자동 수행되며,
 * 서류 작성은 사용자가 브라우저에서 직접 입력합니다.
 */

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const state = require("./state");
const { send, addLog } = require("./utils");
const { signData, getCertBase64 } = require("./signing");

/** 로컬 서명 에이전트 요청인지 판별 */
function _isLocalSigningRequest(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|192\.168\.\d+\.\d+)(:\d+)?/i.test(url);
}

/**
 * 로컬 서명 에이전트 요청에 인증서 서명 데이터로 자동 응답합니다.
 * @param {import('puppeteer-core').HTTPRequest} req
 */
async function _respondToSigningRequest(req) {
  try {
    const postData = req.postData() || "";
    let challenge = null;

    if (postData) {
      try {
        const body = JSON.parse(postData);
        challenge =
          body.data || body.challenge || body.signData ||
          body.plainText || body.msg || body.source;
      } catch {
        challenge = postData;
      }
    }

    const certBase64 = getCertBase64();
    let signedData = "";

    if (challenge) {
      const challengeBuf = Buffer.from(challenge, "base64");
      const result = signData(challengeBuf);
      signedData = result.signedData;
    }

    req.respond({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
      body: JSON.stringify({
        result: 0,
        code: "0000",
        message: "success",
        signedData,
        signature: signedData,
        certificate: certBase64,
        cert: certBase64,
      }),
    });
  } catch (err) {
    addLog(`서명 에이전트 응답 실패: ${err.message}`, "error");
    try { req.continue(); } catch {}
  }
}

/**
 * 인증서 로그인 버튼을 찾아 클릭합니다.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<boolean>}
 */
async function _clickCertLoginButton(page) {
  const selectors = [
    "[onclick*='certLogin']", "[onclick*='CertLogin']",
    "[onclick*='fnLogin']", "[onclick*='fn_login']",
    "[onclick*='loginProc']", "[onclick*='doLogin']",
    "a[href*='certLogin']", "#btnCertLogin",
    ".btn_login_cert", "button[class*='cert']", "a[class*='cert']",
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        return true;
      }
    } catch {}
  }

  // 텍스트 기반 탐색 (fallback)
  return page.evaluate(() => {
    const keywords = ["인증서 로그인", "인증서로그인", "공동인증서", "공인인증서"];
    const els = document.querySelectorAll(
      "a, button, input[type='button'], div[onclick], span[onclick], li[onclick]"
    );
    for (const el of els) {
      const text = (el.textContent || el.value || "").trim();
      for (const kw of keywords) {
        if (text.includes(kw)) { el.click(); return true; }
      }
    }
    return false;
  });
}

/**
 * 서버에서 수신한 efiling_submit 메시지를 처리합니다.
 * CloakBrowser로 전자소송 사이트에 접속하고, 인증서 자동 로그인 후
 * 서류 작성 페이지로 이동합니다.
 * @param {object} msg - efiling_submit 메시지 객체
 * @param {number} msg.draftId - 초안 ID
 * @param {object} msg.data - 서류 데이터
 */
async function handleEfilingSubmit(msg) {
  const { draftId, data } = msg;

  addLog("전자소송 사이트 접속 중...", "info");
  send("agent:efiling-status", { draftId, status: "processing", step: "접속 중" });

  let browser = null;

  try {
    // cloakbrowser는 ESM-only 패키지이므로 dynamic import 사용
    const { launch } = await import("cloakbrowser/puppeteer");

    addLog("CloakBrowser 스텔스 브라우저 실행 중...", "info");

    browser = await launch({
      headless: false, // 서류 작성은 사용자가 직접 입력하므로 headed 모드 유지
      humanize: true,
    });

    const page = await browser.newPage();

    // 다이얼로그 자동 닫기 (서명 프로그램 미설치 안내 등)
    page.on("dialog", async (dialog) => {
      addLog(`[다이얼로그] ${dialog.message().substring(0, 100)}`, "info");
      await dialog.dismiss();
    });

    // 로컬 서명 에이전트 요청 인터셉트 (자동 로그인용)
    if (state.certPath && state.certPassword) {
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const url = req.url();
        if (_isLocalSigningRequest(url)) {
          if (req.method() === "OPTIONS") {
            req.respond({
              status: 200,
              headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Credentials": "true",
              },
            });
            return;
          }
          addLog(`[서명 인터셉트] ${req.method()} ${url}`, "info");
          _respondToSigningRequest(req);
        } else {
          req.continue();
        }
      });
    }

    // 1단계: 전자소송 로그인 페이지 직접 접속
    send("agent:efiling-status", { draftId, status: "processing", step: "전자소송 사이트 접속" });
    await page.goto("https://ecfs.scourt.go.kr/psp/index.on?m=PSP101M01", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // WebSquare SPA 콘텐츠 로드 대기
    await new Promise((r) => setTimeout(r, 3_000));
    addLog("전자소송 포털 접속 완료", "success");

    // 로그인 완료 감지 함수 (공통)
    const loginDetector = () => {
      const sels = [
        ".logout", "[class*='mypage']",
        "[onclick*='logout']", "[onclick*='Logout']",
        "[class*='user_nm']", "[class*='userNm']",
        "[id*='logout']", "[class*='login_after']",
      ];
      for (const s of sels) { if (document.querySelector(s)) return true; }
      const text = document.body ? document.body.innerText : "";
      return text.includes("로그아웃") || text.includes("마이페이지");
    };

    // 2단계: 인증서 자동 로그인 시도
    if (state.certPath && state.certPassword) {
      send("agent:efiling-status", { draftId, status: "processing", step: "자동 로그인" });
      const loginClicked = await _clickCertLoginButton(page);
      if (loginClicked) {
        addLog("인증서 로그인 버튼 클릭. 자동 로그인 대기 중...", "info");
      }

      try {
        await page.waitForFunction(loginDetector, { timeout: 60_000 });
        addLog("자동 로그인 성공", "success");
      } catch {
        addLog("자동 로그인 실패. 브라우저에서 수동으로 로그인하세요.", "warning");
        send("agent:efiling-status", { draftId, status: "awaiting_login", step: "수동 로그인 대기" });

        // 수동 로그인 대기 (추가 120초)
        try {
          await page.waitForFunction(loginDetector, { timeout: 120_000 });
        } catch {
          addLog("로그인 시간 초과. 수동으로 서류를 제출하세요.", "error");
          send("agent:efiling-status", { draftId, status: "manual_required" });
          await browser.close();
          throw new Error("LOGIN_TIMEOUT");
        }
      }
    } else {
      // 인증서 미설정: 수동 로그인 대기
      addLog("인증서 미설정. 브라우저에서 인증서 로그인을 진행하세요.", "info");
      send("agent:efiling-status", { draftId, status: "awaiting_login", step: "수동 로그인 대기" });
      try {
        await page.waitForFunction(loginDetector, { timeout: 120_000 });
      } catch {
        addLog("로그인 시간 초과. 수동으로 서류를 제출하세요.", "error");
        send("agent:efiling-status", { draftId, status: "manual_required" });
        await browser.close();
        throw new Error("LOGIN_TIMEOUT");
      }
    }

    addLog("로그인 확인됨. 서류제출 페이지로 이동합니다.", "success");
    send("agent:efiling-status", { draftId, status: "processing", step: "서류제출 이동" });

    // 3단계: 문서 종류에 따라 서류제출 페이지로 이동
    const submitUrl = _getSubmitUrl(data);
    await page.goto(submitUrl, { waitUntil: "networkidle2", timeout: 30000 });
    addLog("서류제출 페이지 로드 완료", "success");

    // 4단계: 서류 정보를 클립보드에 복사하고 사용자에게 안내
    send("agent:efiling-status", { draftId, status: "processing", step: "폼 입력 중" });

    const formSummary = buildFormSummary(data);

    // WebSquare 기반 UI이므로 직접 DOM 조작 대신 클립보드로 정보 제공
    await page.evaluate((text) => {
      navigator.clipboard.writeText(text).catch(() => {});
    }, formSummary);

    addLog("서류 정보가 클립보드에 복사되었습니다. 브라우저에서 각 항목을 입력하세요.", "info");
    send("agent:efiling-status", { draftId, status: "awaiting_input", step: "사용자 입력 대기" });
    addLog("브라우저에서 서류 작성을 완료한 후 '제출' 버튼을 직접 클릭하세요.", "info");

    // 5단계: 브라우저 세션이 종료될 때까지 대기
    await new Promise((resolve) => {
      browser.on("disconnected", resolve);
    });

    addLog("전자소송 브라우저 세션 종료", "info");
    send("agent:efiling-status", { draftId, status: "completed" });
    _sendEfilingResult(draftId, true, "전자소송 세션이 종료되었습니다.", null);
  } catch (err) {
    addLog(`전자소송 제출 오류: ${err.message}`, "error");
    send("agent:efiling-status", { draftId, status: "error", error: err.message });
    _sendEfilingResult(draftId, false, null, err.message);

    if (browser) {
      try {
        await browser.close();
      } catch {
        // 브라우저 강제 종료 실패 무시
      }
    }
  }
}

/**
 * 문서 종류에 따라 전자소송 제출 URL을 반환합니다.
 * @param {object} data - 서류 데이터
 * @returns {string} 제출 페이지 URL
 */
function _getSubmitUrl(data) {
  const docType = data.doc_type || data.docType || "complaint";
  if (docType === "application") {
    return "https://ecfs.scourt.go.kr/psp/index.on?m=PSPA13M02"; // 민사신청
  }
  return "https://ecfs.scourt.go.kr/psp/index.on?m=PSPA13M01"; // 민사본안(소장)
}

/**
 * efiling_result 메시지를 WebSocket을 통해 서버에 전송합니다.
 * @param {number} draftId - 초안 ID
 * @param {boolean} success - 성공 여부
 * @param {string | null} message - 성공 메시지
 * @param {string | null} error - 에러 메시지
 */
function _sendEfilingResult(draftId, success, message, error) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(
      JSON.stringify({
        type: "efiling_result",
        userId: String(state.userId),
        payload: { draftId, success, message, error },
      })
    );
  }
}

/**
 * 서류 데이터를 사람이 읽기 좋은 텍스트 요약으로 변환합니다.
 * 클립보드에 복사하여 사용자가 ECFS 폼에 붙여넣을 수 있도록 합니다.
 * @param {object} data - 서류 데이터
 * @returns {string} 포맷된 서류 요약 텍스트
 */
function buildFormSummary(data) {
  const parties = typeof data.parties === "string"
    ? JSON.parse(data.parties)
    : data.parties || [];

  const plaintiffs = parties.filter((p) => p.type === "plaintiff");
  const defendants = parties.filter((p) => p.type === "defendant");

  let summary = "=== 전자소송 서류 정보 ===\n\n";
  summary += `[사건명] ${data.case_name || data.caseName || ""}\n`;
  summary += `[관할법원] ${data.court_name || data.courtName || ""}\n`;
  summary += `[소가] ${data.claim_amount || data.claimAmount || ""}\n\n`;

  summary += "[원고]\n";
  plaintiffs.forEach((p, i) => {
    summary += `  ${i + 1}. ${p.name} / ${p.personType === "corporation" ? "법인" : "개인"}\n`;
    summary += `     주소: ${p.address}\n`;
    if (p.phone) summary += `     연락처: ${p.phone}\n`;
    if (p.idNumber) summary += `     식별번호: ${p.idNumber}\n`;
  });

  summary += "\n[피고]\n";
  defendants.forEach((p, i) => {
    summary += `  ${i + 1}. ${p.name} / ${p.personType === "corporation" ? "법인" : "개인"}\n`;
    summary += `     주소: ${p.address}\n`;
    if (p.phone) summary += `     연락처: ${p.phone}\n`;
    if (p.idNumber) summary += `     식별번호: ${p.idNumber}\n`;
  });

  summary += `\n[청구취지]\n${data.claim_purpose || data.claimPurpose || ""}\n`;
  summary += `\n[청구원인]\n${data.claim_reason || data.claimReason || ""}\n`;

  return summary;
}

module.exports = { handleEfilingSubmit, buildFormSummary };
