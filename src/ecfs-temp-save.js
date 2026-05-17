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
    addLog(`ECFS 임시저장 시작: ${docType}`, "info");

    // 라우팅 정보 확인
    const routing = DOC_ROUTING[docType];
    if (!routing) {
      sendResult(ws, userId, requestId, false, `지원하지 않는 서류 유형: ${docType}`);
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
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    };

    browser = CloakBrowser
      ? await CloakBrowser.launch(launchOpts)
      : await puppeteer.launch(launchOpts);

    page = await browser.newPage();

    // 쿠키 설정
    const puppeteerCookies = cookies
      .filter((c) => c.domain.includes("scourt.go.kr"))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
        path: "/",
      }));
    await page.setCookie(...puppeteerCookies);

    // 페이지 이동
    const pageUrl = routing.directUrl
      ? `${ECFS_PSP_URL}?m=${routing.menuParam}&s=${routing.directUrl}`
      : `${ECFS_PSP_URL}?m=${routing.menuParam}`;

    await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 30000 });
    addLog(`ECFS 페이지 로드: ${pageUrl}`, "info");

    // WebSquare 로드 대기
    await page.waitForFunction(
      () => !!(window.wq || window.$w),
      { timeout: 15000 }
    ).catch(() => addLog("WebSquare API 로드 대기 타임아웃 (계속 진행)", "warning"));

    await delay(1000);

    // Type B 서류: 사건확인 후 다음단계 이동
    if (routing.flow === "B" && routing.routing) {
      const { p1, p2, category, docIndex } = routing.routing;
      // 사건확인 데이터 입력 (있으면)
      const formData = parseFormData(draftData);
      if (formData.caseLookup) {
        await fillCaseLookup(page, formData.caseLookup);
      }
      // mvmnNxtStep 호출
      await page.evaluate(
        (p1, p2, cat, docIdx) => {
          if (typeof window.mvmnNxtStep === "function") {
            window.mvmnNxtStep(p1, p2, cat, docIdx, "PSPA0UM01", "");
          }
        },
        p1, p2, category, docIndex
      );
      await delay(2000);
      // 동의 페이지 처리
      await handleConsentPage(page);
    }

    // Type A 서류: 동의 페이지 처리
    if (routing.flow === "A") {
      await handleConsentPage(page);
    }

    await delay(1000);

    // 폼 데이터 입력
    const formData = parseFormData(draftData);
    const fieldsMap = getFieldsMap(docType);
    const fillResult = await fillForm(page, docType, formData, fieldsMap);
    const filledCount = fillResult.filledCount || 0;
    addLog(`ECFS 폼 입력 결과: ${filledCount}개 필드 입력`, filledCount > 0 ? "info" : "warning");

    if (filledCount === 0) {
      addLog("ECFS 폼 필드 입력 실패: 0개 필드 입력됨. 폼 데이터 또는 필드 매핑을 확인하세요.", "error");
      addLog(`formData keys: ${JSON.stringify(Object.keys(formData))}`, "info");
      sendResult(ws, userId, requestId, false, "ECFS 폼 필드 입력에 실패했습니다. 서류 유형 또는 폼 데이터를 확인하세요.");
      return;
    }

    // 임시저장 버튼 클릭
    const tmpSaveBtnId = fieldsMap.buttons.tmpSave;
    const saveClicked = await page.evaluate((btnId) => {
      const api = window.wq || window.$w;
      // WebSquare API로 버튼 클릭
      if (api && typeof api.getComponentById === "function") {
        const btn = api.getComponentById(btnId);
        if (btn && typeof btn.trigger === "function") {
          btn.trigger("click");
          return true;
        }
      }
      // DOM fallback
      const el = document.querySelector(`[id$="${btnId}"]`);
      if (el) { el.click(); return true; }
      return false;
    }, tmpSaveBtnId);

    if (!saveClicked) {
      sendResult(ws, userId, requestId, false, "임시저장 버튼을 찾을 수 없습니다.");
      return;
    }

    // 저장 완료 대기 및 확인 (네트워크 요청 감시)
    addLog("임시저장 버튼 클릭 완료, ECFS 응답 대기 중...", "info");
    let saveConfirmed = false;
    try {
      await page.waitForResponse(
        (res) => res.url().includes(".on") && res.status() === 200,
        { timeout: 10000 }
      );
      saveConfirmed = true;
    } catch {
      addLog("ECFS 저장 응답 감지 타임아웃 (10초). 저장이 완료되었을 수 있습니다.", "warning");
    }

    await delay(1000);

    addLog(`ECFS 임시저장 ${saveConfirmed ? "확인됨" : "완료 (응답 미확인)"}`, saveConfirmed ? "success" : "warning");
    sendResult(ws, userId, requestId, true, null);
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
  const hasConsent = await page.evaluate(() => {
    const chk = document.querySelector('[id*="cbx_agre"], [id*="chk_agree"], input[id*="agre"]');
    return !!chk;
  });

  if (hasConsent) {
    await page.evaluate(() => {
      // 동의 체크박스 클릭
      const checkboxes = document.querySelectorAll('[id*="cbx_agre"] input, [id*="chk_agree"] input, input[id*="agre"]');
      checkboxes.forEach((cb) => { cb.checked = true; cb.click(); });
      // 동의 버튼 클릭
      const btn = document.querySelector('[id*="btn_agre"], [id*="btn_agree"], button[id*="agre"]');
      if (btn) btn.click();
    });
    await delay(2000);
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

      function resolveComponent(shortId) {
        let comp = api.getComponentById(shortId);
        if (comp && typeof comp.setValue === "function") return comp;
        const el = document.querySelector(`[id$="_${shortId}"], [id$="${shortId}"]`);
        if (el && el.id) {
          comp = api.getComponentById(el.id);
          if (comp && typeof comp.setValue === "function") return comp;
        }
        return null;
      }

      function setVal(id, value) {
        try {
          const comp = resolveComponent(id);
          if (comp) { comp.setValue(value); return true; }
        } catch {}
        return false;
      }

      function clickRadio(id) {
        try {
          const el = document.querySelector(`[id$="_${id}"], [id$="${id}"]`);
          if (el) { el.click(); return true; }
        } catch {}
        return false;
      }

      let filledCount = 0;

      // ── 사건기본정보 ──
      if (data.caseBasic) {
        const cb = fields.caseBasic;
        if (data.caseBasic.caseName && setVal(cb.caseName, data.caseBasic.caseName)) filledCount++;
        if (data.caseBasic.courtName && setVal(cb.court, data.caseBasic.courtName)) filledCount++;
        if (data.caseBasic.claimAmount && setVal(cb.claimAmount, String(data.caseBasic.claimAmount))) filledCount++;

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
        setVal(fields.claimPurpose.content, data.content.claimPurpose);
        filledCount++;
      }

      // ── 청구원인 ──
      if (data.content && data.content.claimReason) {
        clickRadio(fields.claimReason.directInput);
        const editorFrame = document.querySelector('iframe[id*="clmCas"], iframe[id*="aplyIntntResn"]');
        if (editorFrame && editorFrame.contentDocument) {
          const body = editorFrame.contentDocument.body;
          if (body) body.innerHTML = data.content.claimReason;
        } else {
          const textarea = document.querySelector('[id*="clmCas"] textarea, [id*="aplyIntntResn"] textarea');
          if (textarea) textarea.value = data.content.claimReason;
        }
        filledCount++;
      }

      return { filled: filledCount > 0, filledCount };
    },
    formData,
    fieldsMap,
    docType
  );
}

module.exports = { handleEcfsTempSave };
