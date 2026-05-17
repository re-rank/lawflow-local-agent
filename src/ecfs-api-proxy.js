/**
 * ecfs-api-proxy.js
 * 백엔드로부터 받은 ECFS API 요청을 사용자 PC에서 직접 실행하고 결과를 반환한다.
 * ECFS는 세션을 로그인 IP에 바인딩하므로, 같은 IP에서 API를 호출해야 한다.
 */

const https = require("https");
const { addLog } = require("./utils");

const ECFS_BASE = "https://ecfs.scourt.go.kr";

/**
 * ECFS API 요청을 처리하고 결과를 WebSocket으로 반환한다.
 * @param {object} payload - { requestId, path, body, cookies }
 * @param {import("ws")} ws - WebSocket 연결
 * @param {string} userId - 사용자 ID
 */
async function handleEcfsApiRequest(payload, ws, userId) {
  const { requestId, path, body, cookies } = payload;

  try {
    addLog(`ECFS API 프록시 요청: ${path}`, "info");

    const result = await ecfsPost(path, body, cookies);

    // 결과를 백엔드로 전송
    const response = JSON.stringify({
      type: "ecfs_api_result",
      userId,
      payload: {
        requestId,
        success: result.success,
        statusCode: result.statusCode,
        data: result.data,
        error: result.error,
      },
    });

    ws.send(response);
    addLog(`ECFS API 프록시 응답 전송: ${path} (성공: ${result.success})`, "info");
  } catch (err) {
    addLog(`ECFS API 프록시 오류: ${err.message}`, "error");

    const response = JSON.stringify({
      type: "ecfs_api_result",
      userId,
      payload: {
        requestId,
        success: false,
        statusCode: 0,
        data: null,
        error: err.message,
      },
    });

    ws.send(response);
  }
}

/**
 * ECFS API에 POST 요청을 보낸다.
 * @param {string} path - API 경로 (예: /psp/psp221/selectInProgCsLst.on)
 * @param {object} body - 요청 본문
 * @param {Array<{name: string, value: string, domain: string}>} cookies - 세션 쿠키
 * @returns {Promise<{success: boolean, statusCode: number, data: object|null, error: string|null}>}
 */
function ecfsPost(path, body, cookies) {
  return new Promise((resolve) => {
    const cookieHeader = cookies
      .filter((c) => c.domain.includes("scourt.go.kr"))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const jsonBody = JSON.stringify(body);
    const url = new URL(path, ECFS_BASE);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        Cookie: cookieHeader,
        Accept: "application/json, text/plain, */*",
        Origin: ECFS_BASE,
        Referer: `${ECFS_BASE}/psp/index.on`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        "Content-Length": Buffer.byteLength(jsonBody),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, statusCode: res.statusCode, data: json, error: null });
          } else {
            // ECFS 인증 실패 (550, 500 등)
            const errorMsg =
              json.errors?.errorMessage || `HTTP ${res.statusCode}: ${res.statusMessage}`;
            resolve({ success: false, statusCode: res.statusCode, data: json, error: errorMsg });
          }
        } catch {
          // JSON 파싱 실패 - 텍스트 응답
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, statusCode: res.statusCode, data: data, error: null });
          } else {
            resolve({
              success: false,
              statusCode: res.statusCode,
              data: null,
              error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}`,
            });
          }
        }
      });
    });

    req.on("error", (err) => {
      resolve({ success: false, statusCode: 0, data: null, error: err.message });
    });

    req.setTimeout(30_000, () => {
      req.destroy();
      resolve({ success: false, statusCode: 0, data: null, error: "요청 타임아웃 (30초)" });
    });

    req.write(jsonBody);
    req.end();
  });
}

module.exports = { handleEcfsApiRequest };
