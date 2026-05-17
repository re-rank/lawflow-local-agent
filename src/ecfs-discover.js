/**
 * ecfs-discover.js
 * ECFS WebSquare 페이지 소스를 HTTPS로 직접 읽어서
 * API 엔드포인트(URL + 파라미터 구조)를 텍스트로 추출한다.
 * Puppeteer 불필요 - Node.js https 모듈만 사용.
 */

const https = require("https");
const { addLog } = require("./utils");

const ECFS_HOST = "ecfs.scourt.go.kr";

/**
 * ECFS 페이지에서 API 엔드포인트를 발견한다.
 * @param {object} payload - { requestId, cookies }
 * @param {import("ws")} ws
 * @param {string} userId
 */
async function handleEcfsDiscover(payload, ws, userId) {
  const { requestId, cookies } = payload;

  try {
    addLog("ECFS 엔드포인트 Discovery 시작 (HTTPS 소스 분석)...", "info");

    const cookieHeader = cookies
      .filter((c) => c.domain.includes("scourt.go.kr"))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    // 1단계: 탐색 대상 페이지 목록
    const pageIds = [
      // 제출서류 관련
      "PSP2E1M01", // 제출서류 목록
      "PSP2E2M01", // 제출서류 상세 (추정)
      "PSP2E1M02", // 제출서류 변형 (추정)
      // 송달문서 관련
      "PSP311M01", // 전체송달문서
      "PSP321M01", // 미확인송달문서
      "PSP312M01", // 송달내역 (추정)
      "PSP311M02", // 송달문서 변형 (추정)
    ];

    // 2단계: 각 페이지의 WebSquare XML/HTML 소스 가져오기
    const results = {};

    // SPA index.on 페이지 먼저 가져와서 구조 파악
    const indexHtml = await _httpsGet(`/psp/index.on?m=PSP2E1M01`, cookieHeader);
    results.indexPage = _extractEndpoints(indexHtml, "index.on");

    // WebSquare XML 페이지 정의 파일 탐색 (여러 패턴 시도)
    for (const pageId of pageIds) {
      const xmlPaths = _getXmlPaths(pageId);
      for (const xmlPath of xmlPaths) {
        try {
          const content = await _httpsGet(xmlPath, cookieHeader);
          if (content && content.length > 100 && !content.includes("404") && !content.includes("error")) {
            addLog(`[Discovery] ${xmlPath} → ${content.length}자 응답`, "info");
            const endpoints = _extractEndpoints(content, xmlPath);
            const submissions = _extractSubmissions(content, xmlPath);
            if (endpoints.length > 0 || submissions.length > 0) {
              results[pageId] = results[pageId] || [];
              results[pageId].push({
                path: xmlPath,
                contentLength: content.length,
                endpoints,
                submissions,
                rawSnippet: content.substring(0, 500),
              });
            }
          }
        } catch {
          // 경로가 없으면 무시
        }
      }
    }

    // 3단계: 알려진 ECFS 엔드포인트 패턴 직접 시도
    const guessedEndpoints = [
      // 제출서류 상세
      { path: "/psp/psp2E1/selectLwstSbmsnDtl.on", desc: "제출서류 상세" },
      { path: "/psp/psp2E1/selectElctnRcptInfo.on", desc: "접수증 정보" },
      { path: "/psp/psp2E1/selectPayInfo.on", desc: "납부 정보" },
      { path: "/psp/psp2E1/selectPayDtl.on", desc: "납부 상세" },
      { path: "/psp/psp2E1/printElctnRcpt.on", desc: "접수증 출력" },
      { path: "/psp/psp2E1/printPayRcpt.on", desc: "납부증 출력" },
      { path: "/psp/psp2E1/selectStmpPayDtl.on", desc: "인지대 납부" },
      { path: "/psp/psp2E1/selectDlvrfPayDtl.on", desc: "송달료 납부" },
      // 송달문서 상세
      { path: "/psp/psp311/selectDlvrDocDtl.on", desc: "송달문서 상세" },
      { path: "/psp/psp311/selectDlvrHist.on", desc: "송달내역" },
      { path: "/psp/psp311/selectDlvrblInfo.on", desc: "송달물 정보" },
      { path: "/psp/psp311/selectDlvrDocFileInfo.on", desc: "문서파일 정보" },
      { path: "/psp/psp311/selectDlvrDocIssu.on", desc: "문서발급" },
      { path: "/psp/psp321/selectUnCfmDlvrDocLst.on", desc: "미확인 송달문서" },
      { path: "/psp/psp321/selectDlvrDocDtl.on", desc: "미확인 송달 상세" },
      { path: "/psp/psp312/selectDlvrPrgrss.on", desc: "송달경과" },
    ];

    const probeResults = [];
    for (const ep of guessedEndpoints) {
      try {
        // 빈 body로 POST 시도 → 응답 확인 (404가 아니면 엔드포인트 존재)
        const resp = await _httpsPost(ep.path, {}, cookieHeader);
        probeResults.push({
          ...ep,
          statusCode: resp.statusCode,
          responseLength: resp.body?.length || 0,
          responseSnippet: (resp.body || "").substring(0, 300),
          exists: resp.statusCode !== 404 && resp.statusCode !== 0,
        });
        addLog(`[Probe] ${ep.path} → HTTP ${resp.statusCode} (${resp.body?.length || 0}자)`, "info");
      } catch (e) {
        probeResults.push({ ...ep, statusCode: 0, error: e.message, exists: false });
      }
    }

    // 4단계: 결과 종합
    const summary = {
      // 존재 확인된 엔드포인트만 필터
      confirmedEndpoints: probeResults.filter((p) => p.exists),
      allProbes: probeResults,
      pageResults: results,
    };

    addLog(`Discovery 완료: ${summary.confirmedEndpoints.length}개 엔드포인트 확인`, "success");

    _sendResult(ws, userId, requestId, true, summary, null);
  } catch (err) {
    addLog(`ECFS Discovery 오류: ${err.message}`, "error");
    _sendResult(ws, userId, requestId, false, null, err.message);
  }
}

/**
 * WebSquare XML 파일의 가능한 경로 목록 생성
 */
function _getXmlPaths(pageId) {
  // PSP2E1M01 → psp2E1
  const prefix = pageId.substring(0, 6).toLowerCase();
  return [
    `/psp/${prefix}/${pageId}.xml`,
    `/psp/${prefix}/${pageId}.js`,
    `/websquare/${prefix}/${pageId}.xml`,
    `/websquare/psp/${prefix}/${pageId}.xml`,
    `/psp/${prefix}/js/${pageId}.js`,
    `/cm/${prefix}/${pageId}.xml`,
  ];
}

/**
 * HTML/XML 소스에서 .on 엔드포인트 URL 추출
 */
function _extractEndpoints(source, context) {
  const endpoints = [];
  // /psp/xxx/yyy.on 패턴 매칭
  const regex = /\/psp\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+\.on/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    endpoints.push({
      url: match[0],
      position: match.index,
      context,
      surrounding: source.substring(Math.max(0, match.index - 50), match.index + match[0].length + 50),
    });
  }
  return endpoints;
}

/**
 * WebSquare XML에서 <w2:submission> 정의 추출
 */
function _extractSubmissions(source, context) {
  const submissions = [];
  // WebSquare submission 패턴
  const subRegex = /<w2:submission[^>]*>/gi;
  let match;
  while ((match = subRegex.exec(source)) !== null) {
    submissions.push({
      tag: match[0].substring(0, 200),
      position: match.index,
      context,
    });
  }

  // action="..." 패턴
  const actionRegex = /action\s*[=:]\s*["']([^"']+\.on)["']/gi;
  while ((match = actionRegex.exec(source)) !== null) {
    submissions.push({
      action: match[1],
      position: match.index,
      context,
    });
  }

  // wq.executeSubmission 패턴
  const execRegex = /executeSubmission\s*\(\s*["']([^"']+)["']/gi;
  while ((match = execRegex.exec(source)) !== null) {
    submissions.push({
      submissionId: match[1],
      position: match.index,
      context,
    });
  }

  return submissions;
}

/**
 * HTTPS GET 요청
 */
function _httpsGet(path, cookieHeader) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: ECFS_HOST,
      port: 443,
      path,
      method: "GET",
      headers: {
        Cookie: cookieHeader,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html, application/xml, application/json, */*",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });

    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

/**
 * HTTPS POST 요청 (엔드포인트 존재 확인용)
 */
function _httpsPost(path, body, cookieHeader) {
  return new Promise((resolve) => {
    const jsonBody = JSON.stringify(body);
    const options = {
      hostname: ECFS_HOST,
      port: 443,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        Cookie: cookieHeader,
        Accept: "application/json, text/plain, */*",
        Origin: `https://${ECFS_HOST}`,
        Referer: `https://${ECFS_HOST}/psp/index.on`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Content-Length": Buffer.byteLength(jsonBody),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });

    req.on("error", (err) => resolve({ statusCode: 0, body: null, error: err.message }));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ statusCode: 0, body: null, error: "timeout" });
    });
    req.write(jsonBody);
    req.end();
  });
}

/**
 * 결과 전송
 */
function _sendResult(ws, userId, requestId, success, data, error) {
  if (!ws || ws.readyState !== 1) {
    addLog("Discovery 결과 전송 실패: WebSocket 미연결", "error");
    return;
  }
  ws.send(JSON.stringify({
    type: "ecfs_discover_result",
    userId,
    payload: { requestId, success, data, error },
  }));
}

module.exports = { handleEcfsDiscover };
