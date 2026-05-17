/**
 * ecfs-discover.js
 * ECFS API 엔드포인트를 빠르게 probe하여 존재 여부를 확인한다.
 * Node.js https 모듈만 사용 (Puppeteer 불필요).
 * 모든 probe를 병렬 실행하여 10초 이내 완료.
 */

const https = require("https");
const { addLog } = require("./utils");

const ECFS_HOST = "ecfs.scourt.go.kr";

/**
 * ECFS 엔드포인트 Discovery
 */
async function handleEcfsDiscover(payload, ws, userId) {
  const { requestId, cookies } = payload;

  try {
    addLog("ECFS 엔드포인트 Discovery 시작...", "info");

    const cookieHeader = cookies
      .filter((c) => c.domain.includes("scourt.go.kr"))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    // 추정 엔드포인트 목록 — 모두 병렬로 probe
    const probes = [
      // 제출서류 관련
      { path: "/psp/psp2E1/selectLwstSbmsnDtl.on", desc: "제출서류 상세" },
      { path: "/psp/psp2E1/selectElctnRcptInfo.on", desc: "접수증 정보" },
      { path: "/psp/psp2E1/selectPayInfo.on", desc: "납부 정보" },
      { path: "/psp/psp2E1/selectPayDtl.on", desc: "납부 상세" },
      { path: "/psp/psp2E1/printElctnRcpt.on", desc: "접수증 출력" },
      { path: "/psp/psp2E1/printPayRcpt.on", desc: "납부증 출력" },
      { path: "/psp/psp2E1/selectStmpPayDtl.on", desc: "인지대 납부" },
      { path: "/psp/psp2E1/selectDlvrfPayDtl.on", desc: "송달료 납부" },
      // 송달문서 관련
      { path: "/psp/psp311/selectDlvrDocDtl.on", desc: "송달문서 상세" },
      { path: "/psp/psp311/selectDlvrHist.on", desc: "송달내역" },
      { path: "/psp/psp311/selectDlvrblInfo.on", desc: "송달물 정보" },
      { path: "/psp/psp311/selectDlvrDocFileInfo.on", desc: "문서파일 정보" },
      { path: "/psp/psp311/selectDlvrDocIssu.on", desc: "문서발급" },
      { path: "/psp/psp321/selectUnCfmDlvrDocLst.on", desc: "미확인 송달목록" },
      { path: "/psp/psp321/selectDlvrDocDtl.on", desc: "미확인 송달 상세" },
      { path: "/psp/psp312/selectDlvrPrgrss.on", desc: "송달경과" },
    ];

    // 모든 probe를 병렬 실행 (5초 타임아웃)
    const results = await Promise.all(
      probes.map(async (ep) => {
        try {
          const resp = await _httpsPost(ep.path, {}, cookieHeader, 5000);
          const exists = resp.statusCode !== 404 && resp.statusCode !== 0;
          addLog(`[Probe] ${ep.path} → HTTP ${resp.statusCode} (${(resp.body || "").length}자)`, "info");
          return {
            ...ep,
            statusCode: resp.statusCode,
            responseLength: (resp.body || "").length,
            responseSnippet: (resp.body || "").substring(0, 500),
            exists,
          };
        } catch (e) {
          return { ...ep, statusCode: 0, error: e.message, exists: false };
        }
      })
    );

    const confirmed = results.filter((r) => r.exists);
    addLog(`Discovery 완료: ${confirmed.length}/${results.length} 엔드포인트 존재 확인`, "success");

    _sendResult(ws, userId, requestId, true, {
      confirmedEndpoints: confirmed,
      allProbes: results,
    }, null);
  } catch (err) {
    addLog(`ECFS Discovery 오류: ${err.message}`, "error");
    _sendResult(ws, userId, requestId, false, null, err.message);
  }
}

/**
 * HTTPS POST (빈 body로 엔드포인트 존재 확인)
 */
function _httpsPost(path, body, cookieHeader, timeoutMs) {
  return new Promise((resolve) => {
    const jsonBody = JSON.stringify(body);
    const req = https.request({
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
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", (err) => resolve({ statusCode: 0, body: null, error: err.message }));
    req.setTimeout(timeoutMs || 5000, () => {
      req.destroy();
      resolve({ statusCode: 0, body: null, error: "timeout" });
    });
    req.write(jsonBody);
    req.end();
  });
}

function _sendResult(ws, userId, requestId, success, data, error) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: "ecfs_discover_result",
    userId,
    payload: { requestId, success, data, error },
  }));
}

module.exports = { handleEcfsDiscover };
