/**
 * ecfs-temp-save.js
 * 에이전트 측에서 ECFS 폼 자동 입력 + 임시저장을 수행한다.
 * 백엔드의 ecfs-form-filler.ts 로직을 에이전트로 이전한 버전.
 *
 * ECFS는 세션을 로그인 IP에 바인딩하므로 사용자 PC에서 실행해야 한다.
 */

const { addLog } = require("./utils");
const { DOC_ROUTING, getFieldsMap } = require("./ecfs-form-fields");

const ECFS_BASE = "https://ecfs.scourt.go.kr";
const ECFS_PSP_URL = `${ECFS_BASE}/psp/index.on`;

/** fillForm 재시도 횟수 */
const FILL_RETRY_COUNT = 3;
/** fillForm 재시도 간격 (ms) */
const FILL_RETRY_DELAY = 2000;

/**
 * ECFS 임시저장 요청을 처리한다.
 * @param {object} payload - { requestId, cookies, docType, draftData }
 * @param {import("ws")} ws - WebSocket 연결
 * @param {string} userId - 사용자 ID
 */
async function handleEcfsTempSave(payload, ws, userId) {
  const { requestId, cookies, docType, draftData } = payload;
  let browser = null;
  let page = null;

  try {
    addLog(`ECFS 임시저장 시작: docType=${docType}`, "info");

    // 라우팅 정보 확인
    const routing = DOC_ROUTING[docType];
    if (!routing) {
      sendResult(ws, userId, requestId, false, `지원하지 않는 서류 유형: ${docType}`);
      return;
    }

    // 폼 데이터 파싱 (미리 수행하여 데이터 문제 조기 발견)
    const formData = parseFormData(draftData);
    addLog(`파싱된 폼 데이터: caseBasic=${!!formData.caseBasic}, parties=${formData.parties.length}명, content.claimPurpose=${(formData.content.claimPurpose || "").substring(0, 30)}...`, "info");

    if (!formData.caseBasic?.caseName && !formData.content?.claimPurpose && formData.parties.length === 0) {
      sendResult(ws, userId, requestId, false, "ECFS에 입력할 폼 데이터가 없습니다. 서류 내용을 먼저 작성하세요.");
      return;
    }

    // 브라우저 실행
    const puppeteer = require("puppeteer-core");
    let CloakBrowser;
    try { CloakBrowser = require("cloakbrowser"); } catch { CloakBrowser = null; }

    const chromePath = findChromePath();
    if (!chromePath) {
      sendResult(ws, userId, requestId, false, "Chrome 브라우저를 찾을 수 없습니다.");
      return;
    }

    const launchOpts = {
      executablePath: chromePath,
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,900",
      ],
    };

    browser = CloakBrowser
      ? await CloakBrowser.launch(launchOpts)
      : await puppeteer.launch(launchOpts);

    page = await browser.newPage();

    // Puppeteer stealth 설정 - headless 감지 회피
    await applyStealthSettings(page);

    // 쿠키 설정
    const puppeteerCookies = cookies
      .filter((c) => c.domain && c.domain.includes("scourt.go.kr"))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
        path: "/",
      }));

    if (puppeteerCookies.length === 0) {
      sendResult(ws, userId, requestId, false, "ECFS 세션 쿠키가 없습니다. 인증서 로그인을 먼저 해주세요.");
      return;
    }

    await page.setCookie(...puppeteerCookies);
    addLog(`ECFS 쿠키 설정: ${puppeteerCookies.length}개`, "info");

    // 페이지 이동
    const pageUrl = routing.directUrl
      ? `${ECFS_PSP_URL}?m=${routing.menuParam}&s=${routing.directUrl}`
      : `${ECFS_PSP_URL}?m=${routing.menuParam}`;

    addLog(`ECFS 페이지 이동: ${pageUrl}`, "info");
    await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // 로그인 리다이렉트 감지
    const currentUrl = page.url();
    const pageTitle = await page.title();
    addLog(`페이지 로드 완료: URL=${currentUrl}, 타이틀=${pageTitle}`, "info");

    if (currentUrl.includes("/usr/") || currentUrl.includes("login") || currentUrl.includes("USR")) {
      sendResult(ws, userId, requestId, false, "ECFS 세션이 만료되었습니다. 인증서 로그인을 다시 해주세요.");
      return;
    }

    // WebSquare 로드 대기
    const wsqReady = await waitForWebSquare(page);
    if (!wsqReady) {
      addLog("WebSquare API를 찾을 수 없습니다. 페이지가 정상 로드되지 않았을 수 있습니다.", "error");
      // 페이지 상태 진단
      await logPageDiagnostics(page);
      sendResult(ws, userId, requestId, false, "ECFS 페이지가 정상적으로 로드되지 않았습니다. 인증서 로그인 상태를 확인하세요.");
      return;
    }

    await delay(1500);

    // Type B 서류: 사건확인 후 다음단계 이동
    if (routing.flow === "B" && routing.routing) {
      const { p1, p2, category, docIndex } = routing.routing;
      if (formData.caseLookup) {
        await fillCaseLookup(page, formData.caseLookup);
      }
      await page.evaluate(
        (p1, p2, cat, docIdx) => {
          if (typeof window.mvmnNxtStep === "function") {
            window.mvmnNxtStep(p1, p2, cat, docIdx, "PSPA0UM01", "");
          }
        },
        p1, p2, category, docIndex
      );
      await delay(2000);
      await handleConsentPage(page);
    }

    // Type A 서류: 동의 페이지 처리
    if (routing.flow === "A") {
      await handleConsentPage(page);
    }

    // 폼 요소가 실제로 렌더링될 때까지 대기
    const fieldsMap = getFieldsMap(docType);
    await waitForFormElements(page, fieldsMap);

    // 폼 데이터 입력 (재시도 포함)
    let fillResult = null;
    for (let attempt = 1; attempt <= FILL_RETRY_COUNT; attempt++) {
      fillResult = await fillForm(page, docType, formData, fieldsMap);
      const filledCount = fillResult.filledCount || 0;
      addLog(`ECFS 폼 입력 시도 ${attempt}/${FILL_RETRY_COUNT}: ${filledCount}개 필드 입력${fillResult.error ? ` (오류: ${fillResult.error})` : ""}`, filledCount > 0 ? "info" : "warning");

      // fillForm 내부 로그 출력 (어떤 필드가 성공/실패했는지 상세 확인)
      if (fillResult.log && fillResult.log.length > 0) {
        addLog(`폼 입력 상세: ${fillResult.log.join(" | ")}`, "info");
      }

      if (filledCount > 0) break;

      if (attempt < FILL_RETRY_COUNT) {
        addLog(`폼 입력 재시도를 위해 ${FILL_RETRY_DELAY}ms 대기...`, "info");
        await delay(FILL_RETRY_DELAY);
      }
    }

    const filledCount = fillResult?.filledCount || 0;

    if (filledCount === 0) {
      addLog("ECFS 폼 필드 입력 실패: 모든 시도에서 0개 필드 입력됨", "error");
      addLog(`formData 키: ${JSON.stringify(Object.keys(formData))}`, "info");
      // 페이지 상태 진단
      await logPageDiagnostics(page);
      sendResult(ws, userId, requestId, false, "ECFS 폼 필드 입력에 실패했습니다. 서류 유형 또는 폼 데이터를 확인하세요.");
      return;
    }

    // ── 임시저장 실행 ──

    // [FIX] dialog 핸들러를 저장 버튼 클릭 *전*에 등록
    // ECFS는 저장 시 "임시저장 하시겠습니까?" confirm을 띄울 수 있음
    let dialogMessages = [];
    page.on("dialog", async (dialog) => {
      const msg = dialog.message();
      addLog(`ECFS 대화상자: ${dialog.type()} - ${msg}`, "info");
      dialogMessages.push(msg);
      await dialog.accept();
    });

    const tmpSaveBtnId = fieldsMap.buttons.tmpSave;
    addLog(`임시저장 버튼 클릭 시도: ${tmpSaveBtnId}`, "info");

    // 버튼의 실제 CSS 셀렉터를 먼저 찾는다
    const btnSelector = await page.evaluate((btnId) => {
      const selectors = [
        `[id$="_${btnId}"]`,
        `[id$="${btnId}"]`,
        `#${btnId}`,
        `button[id*="${btnId}"]`,
        `a[id*="${btnId}"]`,
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          // 버튼 상태 확인
          const info = {
            selector: el.id ? `#${el.id}` : sel,
            id: el.id,
            tagName: el.tagName,
            visible: el.offsetParent !== null,
            disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
            text: (el.textContent || "").trim().substring(0, 30),
          };
          return info;
        }
      }
      return null;
    }, tmpSaveBtnId);

    if (!btnSelector) {
      addLog(`임시저장 버튼을 찾을 수 없음: ${tmpSaveBtnId}`, "error");
      await logPageDiagnostics(page);
      sendResult(ws, userId, requestId, false, "임시저장 버튼을 찾을 수 없습니다.");
      return;
    }

    addLog(`임시저장 버튼 발견: id=${btnSelector.id}, tag=${btnSelector.tagName}, visible=${btnSelector.visible}, disabled=${btnSelector.disabled}, text="${btnSelector.text}"`, "info");

    // 콘솔 메시지 캡처 (JS 에러 감지용)
    const consoleMessages = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    // 모든 네트워크 요청 감시 (어떤 요청이 발생하는지 확인)
    const networkRequests = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes(".on") || url.includes("save") || url.includes("Save")) {
        networkRequests.push(url);
      }
    });

    // ── 버튼 클릭 방법 3단계 시도 ──

    // 방법 1: WebSquare scwin 함수 직접 호출 (가장 확실)
    const scwinResult = await page.evaluate((btnId) => {
      try {
        // WebSquare에서 버튼 onclick 핸들러는 scwin.{btnId}_onclick 형식
        const scwinScope = window.scwin || (window.$w && window.$w.scwin);
        if (scwinScope) {
          const handlerName = `${btnId}_onclick`;
          if (typeof scwinScope[handlerName] === "function") {
            scwinScope[handlerName]();
            return `scwin:${handlerName}`;
          }
          // scwin 내 함수 목록에서 tmpSave 관련 함수 검색
          const tmpSaveFns = Object.keys(scwinScope).filter(
            (k) => typeof scwinScope[k] === "function" &&
              (k.toLowerCase().includes("tmpsave") || k.toLowerCase().includes("tmp_save") || k.toLowerCase().includes("임시저장"))
          );
          if (tmpSaveFns.length > 0) {
            scwinScope[tmpSaveFns[0]]();
            return `scwin:${tmpSaveFns[0]}`;
          }
          return { notFound: true, availableFns: Object.keys(scwinScope).filter((k) => typeof scwinScope[k] === "function").slice(0, 30) };
        }
        return { noScwin: true };
      } catch (e) {
        return { error: e.message };
      }
    }, tmpSaveBtnId);

    if (typeof scwinResult === "string") {
      addLog(`임시저장 함수 직접 호출 성공: ${scwinResult}`, "info");
    } else {
      // scwin 함수 호출 실패 → 로그 출력 후 Puppeteer 클릭으로 fallback
      if (scwinResult?.availableFns) {
        addLog(`scwin에서 tmpSave 함수 못 찾음. 사용 가능한 함수: ${scwinResult.availableFns.join(", ")}`, "warning");
      } else {
        addLog(`scwin 접근 실패: ${JSON.stringify(scwinResult)}`, "warning");
      }

      // 방법 2: Puppeteer 네이티브 클릭
      try {
        await page.click(btnSelector.selector);
        addLog(`Puppeteer click: ${btnSelector.selector}`, "info");
      } catch (clickErr) {
        addLog(`Puppeteer click 실패: ${clickErr.message}`, "warning");
        // 방법 3: dispatchEvent
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        }, btnSelector.selector);
        addLog(`dispatch-click: ${btnSelector.selector}`, "info");
      }
    }

    // 저장 응답 감시 (모든 .on 요청 대상)
    let saveConfirmed = false;
    let saveResponseBody = null;
    try {
      const response = await page.waitForResponse(
        (res) => res.url().includes(".on") && res.status() === 200,
        { timeout: 15000 }
      );
      const respUrl = response.url();
      addLog(`ECFS 저장 응답 URL: ${respUrl} (${response.status()})`, "info");

      // 응답 본문 확인
      try {
        saveResponseBody = await response.text();
        addLog(`ECFS 저장 응답 본문 (앞 300자): ${(saveResponseBody || "").substring(0, 300)}`, "info");
        // ECFS 성공 응답은 보통 JSON에 에러 메시지가 없음
        if (saveResponseBody && !saveResponseBody.includes("오류") && !saveResponseBody.includes("실패") && !saveResponseBody.includes("error")) {
          saveConfirmed = true;
        } else {
          addLog("ECFS 저장 응답에 오류 징후가 있습니다.", "warning");
        }
      } catch {
        // 응답 본문을 읽을 수 없는 경우에도 URL 매칭은 된 것이므로 일단 성공으로
        saveConfirmed = true;
      }
    } catch {
      addLog("ECFS 저장 응답 감지 타임아웃 (15초)", "warning");
    }

    // dialog가 떴을 수 있으므로 잠시 대기
    await delay(2000);

    // [FIX] dialog 메시지로 저장 성공 여부 추가 판단
    if (dialogMessages.length > 0) {
      addLog(`ECFS 대화상자 메시지들: ${JSON.stringify(dialogMessages)}`, "info");
      const hasSuccess = dialogMessages.some((m) =>
        m.includes("저장") || m.includes("완료") || m.includes("성공")
      );
      const hasError = dialogMessages.some((m) =>
        m.includes("오류") || m.includes("실패") || m.includes("입력") || m.includes("확인")
      );
      if (hasSuccess && !hasError) {
        saveConfirmed = true;
        addLog("ECFS 대화상자에서 저장 성공 확인", "success");
      } else if (hasError) {
        saveConfirmed = false;
        addLog("ECFS 대화상자에서 오류 감지", "error");
      }
    }

    // 콘솔 에러/네트워크 요청 로그 출력
    if (consoleMessages.length > 0) {
      addLog(`브라우저 콘솔: ${consoleMessages.slice(0, 5).join(" | ")}`, "warning");
    }
    if (networkRequests.length > 0) {
      addLog(`감지된 네트워크 요청: ${networkRequests.join(" | ")}`, "info");
    } else {
      addLog("버튼 클릭 후 네트워크 요청 없음", "warning");
    }

    // saveConfirmed가 false이면 실패로 보고
    if (saveConfirmed) {
      addLog("ECFS 임시저장 확인됨", "success");
      sendResult(ws, userId, requestId, true, null);
    } else {
      addLog("ECFS 임시저장 미확인: 저장 응답을 받지 못했습니다.", "error");
      await logPageDiagnostics(page);
      sendResult(ws, userId, requestId, false,
        "ECFS 임시저장이 완료되지 않았습니다. 저장 응답을 확인할 수 없습니다. " +
        (dialogMessages.length > 0 ? `ECFS 메시지: ${dialogMessages.join(", ")}` : "") +
        (consoleMessages.length > 0 ? ` 콘솔에러: ${consoleMessages[0]}` : "") +
        (networkRequests.length === 0 ? " (네트워크 요청 없음)" : "")
      );
    }
  } catch (err) {
    addLog(`ECFS 임시저장 오류: ${err.message}`, "error");
    sendResult(ws, userId, requestId, false, err.message);
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

// ── 헬퍼 함수들 ──────────────────────────────────────────

function sendResult(ws, userId, requestId, success, error) {
  ws.send(JSON.stringify({
    type: "ecfs_temp_save_result",
    userId,
    payload: { requestId, success, error },
  }));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findChromePath() {
  const fs = require("fs");
  const paths = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ].filter(Boolean);
  return paths.find((p) => fs.existsSync(p)) || null;
}

/**
 * Puppeteer stealth 설정 - headless 감지 회피
 */
async function applyStealthSettings(page) {
  // navigator.webdriver 속성 제거
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // chrome.runtime 추가 (headless에서 누락됨)
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
    // permissions 쿼리 오버라이드
    const origQuery = window.navigator.permissions?.query;
    if (origQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(parameters);
    }
    // plugins 배열 비어있지 않게
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
    // languages 설정
    Object.defineProperty(navigator, "languages", {
      get: () => ["ko-KR", "ko", "en-US", "en"],
    });
  });

  // User-Agent 설정 (headless 흔적 제거)
  const ua = await page.evaluate(() => navigator.userAgent);
  await page.setUserAgent(ua.replace("HeadlessChrome", "Chrome"));

  // viewport 설정
  await page.setViewport({ width: 1280, height: 900 });
}

/**
 * WebSquare API가 로드될 때까지 대기
 * @returns {Promise<boolean>} WebSquare 사용 가능 여부
 */
async function waitForWebSquare(page) {
  try {
    await page.waitForFunction(
      () => {
        const api = window.wq || window.$w;
        return !!(api && typeof api.getComponentById === "function");
      },
      { timeout: 20000 }
    );
    addLog("WebSquare API 로드 확인", "info");
    return true;
  } catch {
    addLog("WebSquare API 로드 타임아웃 (20초)", "warning");
    return false;
  }
}

/**
 * 폼 요소가 실제로 렌더링될 때까지 대기
 */
async function waitForFormElements(page, fieldsMap) {
  const sampleIds = [];
  if (fieldsMap.caseBasic?.caseName) sampleIds.push(fieldsMap.caseBasic.caseName);
  if (fieldsMap.buttons?.tmpSave) sampleIds.push(fieldsMap.buttons.tmpSave);
  if (fieldsMap.claimPurpose?.content) sampleIds.push(fieldsMap.claimPurpose.content);

  if (sampleIds.length === 0) return;

  try {
    await page.waitForFunction(
      (ids) => {
        const api = window.wq || window.$w;
        if (!api || typeof api.getComponentById !== "function") return false;
        // 샘플 ID 중 하나라도 찾으면 폼 준비 완료로 판단
        return ids.some((id) => {
          const comp = api.getComponentById(id);
          if (comp) return true;
          const el = document.querySelector(`[id$="_${id}"], [id$="${id}"], #${id}`);
          return !!el;
        });
      },
      { timeout: 10000 },
      sampleIds
    );
    addLog("폼 요소 렌더링 확인", "info");
  } catch {
    addLog("폼 요소 렌더링 대기 타임아웃 (10초) - 계속 진행", "warning");
  }

  await delay(500);
}

/**
 * 페이지 상태 진단 로깅 (디버깅용)
 */
async function logPageDiagnostics(page) {
  try {
    const diag = await page.evaluate(() => {
      const api = window.wq || window.$w;
      const hasApi = !!(api && typeof api.getComponentById === "function");

      // 페이지에 있는 주요 요소 확인
      const forms = document.querySelectorAll("form");
      const inputs = document.querySelectorAll("input[type='text'], textarea, select");
      const buttons = document.querySelectorAll("button, a.btn, [role='button']");

      // body의 처음 500자
      const bodyText = (document.body?.innerText || "").substring(0, 500);

      // ECFS 관련 요소 찾기
      const wsqElements = document.querySelectorAll("[id*='ibx_'], [id*='sbx_'], [id*='txa_'], [id*='btn_']");
      const wsqIds = Array.from(wsqElements).slice(0, 20).map((e) => e.id);

      return {
        url: location.href,
        title: document.title,
        hasWebSquare: hasApi,
        formCount: forms.length,
        inputCount: inputs.length,
        buttonCount: buttons.length,
        bodyPreview: bodyText,
        wsqElementIds: wsqIds,
      };
    });

    addLog(`[진단] URL: ${diag.url}`, "info");
    addLog(`[진단] WebSquare: ${diag.hasWebSquare}, Forms: ${diag.formCount}, Inputs: ${diag.inputCount}, Buttons: ${diag.buttonCount}`, "info");
    addLog(`[진단] WebSquare 요소 IDs: ${diag.wsqElementIds.join(", ") || "(없음)"}`, "info");
    if (diag.bodyPreview) {
      addLog(`[진단] 페이지 내용: ${diag.bodyPreview.substring(0, 200)}`, "info");
    }
  } catch (e) {
    addLog(`[진단] 페이지 진단 실패: ${e.message}`, "warning");
  }
}

/**
 * DB 초안 데이터를 폼 입력용 구조로 파싱
 */
function parseFormData(draftData) {
  let formData = {};
  if (typeof draftData.form_data === "string") {
    try { formData = JSON.parse(draftData.form_data); } catch { formData = {}; }
  } else {
    formData = draftData.form_data || draftData.formData || {};
  }

  let parties = [];
  if (typeof draftData.parties === "string") {
    try { parties = JSON.parse(draftData.parties); } catch { parties = []; }
  } else {
    parties = draftData.parties || [];
  }

  return {
    caseBasic: formData.caseBasic || {
      caseName: draftData.case_name || draftData.caseName || "",
      courtName: draftData.court_name || draftData.courtName || "",
      claimAmount: draftData.claim_amount || draftData.claimAmount || null,
      claimDivision: "property",
      claimAmountType: "amount",
    },
    caseLookup: formData.caseLookup || null,
    paymentOrder: formData.paymentOrder || null,
    parties,
    attorneys: formData.attorneys || [],
    content: formData.content || {
      claimPurpose: draftData.claim_purpose || draftData.claimPurpose || "",
      claimReason: draftData.claim_reason || draftData.claimReason || "",
    },
  };
}

/**
 * 사건확인 입력 (Type B 서류)
 */
async function fillCaseLookup(page, lookup) {
  await page.evaluate((data) => {
    const api = window.wq || window.$w;
    if (!api || typeof api.getComponentById !== "function") return;

    function setVal(id, value) {
      let comp = api.getComponentById(id);
      if (comp && typeof comp.setValue === "function") { comp.setValue(value); return; }
      const el = document.querySelector(`[id$="_${id}"], [id$="${id}"]`);
      if (el && el.id) {
        comp = api.getComponentById(el.id);
        if (comp && typeof comp.setValue === "function") comp.setValue(value);
      }
    }

    if (data.lawsuitType) setVal("sbx_elctnLwstTaskTypCd", data.lawsuitType);
    if (data.courtCode) setVal("sbx_cortCd", data.courtCode);
    if (data.caseYear) setVal("sbx_csYear", data.caseYear);
    if (data.caseDivision) setVal("acp_csDvsCd_input", data.caseDivision);
    if (data.caseSerial) setVal("ibx_csSerial", data.caseSerial);
    if (data.relationType) setVal("sbx_lwstRltnrTyp", data.relationType);
    if (data.partyDivision) setVal("sbx_btprtDvsCd", data.partyDivision);
  }, lookup);
}

/**
 * 전자소송 동의 페이지 자동 처리
 */
async function handleConsentPage(page) {
  // 동의 체크박스가 나타날 때까지 잠시 대기
  let hasConsent = false;
  for (let i = 0; i < 5; i++) {
    hasConsent = await page.evaluate(() => {
      const chk = document.querySelector(
        '[id*="cbx_agre"], [id*="chk_agree"], [id*="chk_agre"], input[id*="agre"], [id*="agreAll"]'
      );
      return !!chk;
    });
    if (hasConsent) break;
    await delay(1000);
  }

  if (hasConsent) {
    addLog("동의 페이지 감지 - 자동 동의 처리", "info");
    await page.evaluate(() => {
      // 동의 체크박스 클릭
      const checkboxes = document.querySelectorAll(
        '[id*="cbx_agre"] input, [id*="chk_agree"] input, [id*="chk_agre"] input, input[id*="agre"], [id*="agreAll"] input'
      );
      checkboxes.forEach((cb) => {
        if (!cb.checked) { cb.checked = true; cb.click(); }
      });

      // WebSquare 체크박스도 처리
      const api = window.wq || window.$w;
      if (api && typeof api.getComponentById === "function") {
        const agreIds = ["cbx_agre", "chk_agree", "chk_agre", "agreAll"];
        agreIds.forEach((id) => {
          const comp = api.getComponentById(id);
          if (comp && typeof comp.setValue === "function") {
            comp.setValue(true);
          } else if (comp && typeof comp.check === "function") {
            comp.check();
          }
        });
      }
    });

    await delay(500);

    // 동의 버튼 클릭
    await page.evaluate(() => {
      const btnSelectors = [
        '[id*="btn_agre"]', '[id*="btn_agree"]', 'button[id*="agre"]',
        '[id*="btn_cnfm"]', '[id*="btn_next"]', '[id*="btn_nxt"]',
      ];
      for (const sel of btnSelectors) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          return;
        }
      }
      // WebSquare 버튼도 시도
      const api = window.wq || window.$w;
      if (api && typeof api.getComponentById === "function") {
        const btnIds = ["btn_agre", "btn_agree", "btn_cnfm"];
        for (const id of btnIds) {
          const comp = api.getComponentById(id);
          if (comp && typeof comp.trigger === "function") {
            comp.trigger("click");
            return;
          }
        }
      }
    });

    // 동의 후 폼 페이지 로드 대기
    addLog("동의 처리 완료, 폼 페이지 로드 대기...", "info");
    await delay(3000);
  } else {
    addLog("동의 페이지 없음 (건너뜀)", "info");
  }
}

/**
 * 폼 자동 입력 (page.evaluate로 WebSquare API 제어)
 */
async function fillForm(page, docType, formData, fieldsMap) {
  return await page.evaluate(
    (data, fields, docType) => {
      const api = window.wq || window.$w;
      if (!api || typeof api.getComponentById !== "function") {
        return { filled: false, filledCount: 0, error: "WebSquare API 없음" };
      }

      const log = [];

      function resolveComponent(shortId) {
        // 1. 직접 ID로 조회
        let comp = api.getComponentById(shortId);
        if (comp && typeof comp.setValue === "function") return comp;

        // 2. DOM에서 suffix 매치
        const el = document.querySelector(`[id$="_${shortId}"], [id$="${shortId}"]`);
        if (el && el.id) {
          comp = api.getComponentById(el.id);
          if (comp && typeof comp.setValue === "function") return comp;
        }

        // 3. 정확한 ID 매치
        const exact = document.getElementById(shortId);
        if (exact) {
          comp = api.getComponentById(exact.id);
          if (comp && typeof comp.setValue === "function") return comp;
        }

        return null;
      }

      function setVal(id, value) {
        try {
          const comp = resolveComponent(id);
          if (comp) {
            comp.setValue(value);
            // change 이벤트 트리거 (WebSquare가 감지하도록)
            if (typeof comp.trigger === "function") {
              try { comp.trigger("change"); } catch { /* ignore */ }
            }
            // [FIX] setValue 후 실제로 값이 반영되었는지 검증
            let actualVal = "";
            try {
              if (typeof comp.getValue === "function") actualVal = comp.getValue();
            } catch { /* ignore */ }
            const valStr = String(value).substring(0, 20);
            const actStr = String(actualVal).substring(0, 20);
            if (actualVal && String(actualVal) !== String(value)) {
              log.push(`WARN: ${id} set=${valStr} got=${actStr}`);
            } else {
              log.push(`OK: ${id} = ${valStr}`);
            }
            return true;
          }
          log.push(`MISS: ${id} (컴포넌트 없음)`);
        } catch (e) {
          log.push(`ERR: ${id} - ${e.message}`);
        }
        return false;
      }

      function clickRadio(id) {
        try {
          // 1. WebSquare 직접 ID
          let comp = api.getComponentById(id);
          if (comp && typeof comp.trigger === "function") { comp.trigger("click"); return true; }

          // 2. DOM suffix 매칭 → full ID로 WebSquare trigger
          const el = document.querySelector(`[id$="_${id}"], [id$="${id}"], #${id}`);
          if (el && el.id) {
            comp = api.getComponentById(el.id);
            if (comp && typeof comp.trigger === "function") { comp.trigger("click"); return true; }
            el.click();
            return true;
          }
        } catch {}
        return false;
      }

      let filledCount = 0;

      // ── 사건기본정보 ──
      if (data.caseBasic) {
        const cb = fields.caseBasic;
        if (data.caseBasic.caseName && cb.caseName && setVal(cb.caseName, data.caseBasic.caseName)) filledCount++;
        if (data.caseBasic.courtName && cb.court && setVal(cb.court, data.caseBasic.courtName)) filledCount++;
        if (data.caseBasic.claimAmount && cb.claimAmount && setVal(cb.claimAmount, String(data.caseBasic.claimAmount))) filledCount++;

        if (cb.claimDiv_property) {
          if (data.caseBasic.claimDivision === "property") clickRadio(cb.claimDiv_property);
          else if (cb.claimDiv_non) clickRadio(cb.claimDiv_non);
        }

        if (cb.amtType_amount) {
          if (data.caseBasic.claimAmountType === "amount") clickRadio(cb.amtType_amount);
          else if (data.caseBasic.claimAmountType === "land") clickRadio(cb.amtType_land);
          else if (cb.amtType_uncalc) clickRadio(cb.amtType_uncalc);
        }
      }

      // ── 당사자 입력 ──
      if (data.parties && data.parties.length > 0) {
        const pf = fields.party;

        function fillParty(party) {
          if (!party) return;
          if (party.type === "plaintiff") clickRadio(pf.typePlaintiff);
          else clickRadio(pf.typeDefendant);

          const personMap = { individual: "1", corporation: "2", non_corp: "3", government: "4", local_gov: "5" };
          if (party.personType) setVal(pf.personType, personMap[party.personType] || "1");
          if (party.isNonMember && pf.nonMember) clickRadio(pf.nonMember);
          if (party.name) setVal(pf.name, party.name);
          if (party.idFront) setVal(pf.idFront, party.idFront);
          if (party.idBack) setVal(pf.idBack, party.idBack);
          if (party.representativeTitle) setVal(pf.reprTitle, party.representativeTitle);
          if (party.representativeName) setVal(pf.reprName, party.representativeName);
          if (party.zipCode) setVal(pf.zipCode, party.zipCode);
          if (party.baseAddress) setVal(pf.baseAddr, party.baseAddress);
          if (party.detailAddress) setVal(pf.detailAddr, party.detailAddress);

          if (party.sameAsAddress && pf.sameAddr) {
            clickRadio(pf.sameAddr);
          } else {
            if (party.deliveryZipCode) setVal(pf.deliveryZip, party.deliveryZipCode);
            if (party.deliveryBaseAddress) setVal(pf.deliveryBase, party.deliveryBaseAddress);
            if (party.deliveryDetailAddress) setVal(pf.deliveryDetail, party.deliveryDetailAddress);
          }

          if (party.mobile) {
            const parts = party.mobile.replace(/-/g, "").match(/^(\d{2,3})(\d{3,4})(\d{4})$/);
            if (parts) {
              setVal(pf.mobilePrefix, parts[1]);
              setVal(pf.mobile2, parts[2]);
              setVal(pf.mobile3, parts[3]);
            }
          }
          if (party.email) {
            const ep = party.email.split("@");
            if (ep.length === 2) { setVal(pf.emailId, ep[0]); setVal(pf.emailDomain, ep[1]); }
          }
        }

        const plaintiff = data.parties.find((p) => p.type === "plaintiff");
        if (plaintiff) { fillParty(plaintiff); filledCount++; }

        const addBtn = document.querySelector('[id*="btn_btprtAdd"], [id*="btn_add"]');
        if (addBtn) addBtn.click();

        const defendant = data.parties.find((p) => p.type === "defendant");
        if (defendant) { fillParty(defendant); filledCount++; }
      }

      // ── 청구취지 ──
      if (data.content && data.content.claimPurpose) {
        if (setVal(fields.claimPurpose.content, data.content.claimPurpose)) {
          filledCount++;
        }
      }

      // ── 청구원인 ──
      if (data.content && data.content.claimReason) {
        clickRadio(fields.claimReason.directInput);
        const editorFrame = document.querySelector('iframe[id*="clmCas"], iframe[id*="aplyIntntResn"], iframe[id*="aplyResn"]');
        if (editorFrame && editorFrame.contentDocument) {
          const body = editorFrame.contentDocument.body;
          if (body) { body.innerHTML = data.content.claimReason; filledCount++; }
        } else {
          const textarea = document.querySelector('[id*="clmCas"] textarea, [id*="aplyIntntResn"] textarea, [id*="aplyResn"] textarea');
          if (textarea) { textarea.value = data.content.claimReason; filledCount++; }
        }
      }

      return { filled: filledCount > 0, filledCount, log };
    },
    formData,
    fieldsMap,
    docType
  );
}

module.exports = { handleEcfsTempSave };
