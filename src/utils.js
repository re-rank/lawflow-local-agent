/**
 * utils.js
 * 공통 헬퍼 함수 모음
 */

const state = require("./state");

/**
 * 렌더러 프로세스(mainWindow)에 IPC 메시지를 안전하게 전송합니다.
 * @param {string} channel - IPC 채널명
 * @param {any} data - 전송할 데이터
 */
function send(channel, data) {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send(channel, data);
  }
}

/**
 * JWT 토큰을 디코딩하여 payload 객체를 반환합니다.
 * @param {string} token - JWT 토큰 문자열
 * @returns {object} 디코딩된 payload
 * @throws JWT 형식이 올바르지 않으면 에러를 던집니다.
 */
function decodeJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("잘못된 JWT 형식");
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload);
}

/**
 * agent:log 채널로 로그 메시지를 전송하는 단축 함수입니다.
 * @param {string} message - 로그 메시지
 * @param {"info"|"success"|"warning"|"error"} type - 로그 타입
 */
function addLog(message, type = "info") {
  send("agent:log", { message, type });
}

module.exports = { send, decodeJwt, addLog };
