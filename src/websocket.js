/**
 * websocket.js
 * WebSocket 연결, 하트비트, 재연결, 수신 메시지 라우팅 처리
 */

const WebSocket = require("ws");
const state = require("./state");
const { send, addLog } = require("./utils");
const { updateTray } = require("./tray");
const { handleSignRequest } = require("./signing");
const { handleEfilingSubmit } = require("./efiling-submit");
const { handleEcfsLogin } = require("./ecfs-login");

/**
 * WebSocket을 통해 서버에 연결합니다.
 * 기존 연결이 있으면 먼저 해제한 후 새로 연결합니다.
 * @param {string} serverUrl - 백엔드 서버 URL (http/https)
 */
function connectWs(serverUrl) {
  disconnectWs();

  // http/https를 ws/wss로 변환하여 WebSocket URL 구성
  const wsUrl =
    serverUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) + "/ws/agent";

  addLog(`서버 연결 중: ${wsUrl}`, "info");

  try {
    state.ws = new WebSocket(wsUrl);
  } catch (err) {
    addLog(`WebSocket 생성 실패: ${err.message}`, "error");
    send("agent:status", { connected: false });
    scheduleReconnect(serverUrl);
    return;
  }

  state.ws.on("open", () => _onOpen(serverUrl));
  state.ws.on("message", (raw) => _onMessage(raw));
  state.ws.on("close", (code) => _onClose(code, serverUrl));
  state.ws.on("error", (err) => addLog(`연결 오류: ${err.message}`, "error"));
}

/**
 * WebSocket 연결을 정상 종료합니다.
 * 하트비트/재연결 타이머도 함께 정리합니다.
 */
function disconnectWs() {
  clearInterval(state.heartbeatTimer);
  clearTimeout(state.reconnectTimer);
  state.heartbeatTimer = null;
  state.reconnectTimer = null;

  if (state.ws) {
    state.ws.removeAllListeners();
    if (state.ws.readyState === WebSocket.OPEN) {
      state.ws.close(1000); // 정상 종료 코드
    }
    state.ws = null;
  }

  send("agent:status", { connected: false });
  updateTray(false);
}

/**
 * 지정된 시간(5초) 후 재연결을 시도하도록 예약합니다.
 * @param {string} serverUrl - 재연결할 서버 URL
 */
function scheduleReconnect(serverUrl) {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => connectWs(serverUrl), 5_000);
}

// ── 내부 이벤트 핸들러 ────────────────────────────────────

/**
 * WebSocket open 이벤트: 에이전트 등록 요청 및 하트비트 시작
 * @param {string} serverUrl - 현재 연결된 서버 URL (재연결 시 사용)
 */
function _onOpen(serverUrl) {
  addLog("WebSocket 연결됨", "success");

  // 서버에 에이전트 등록 메시지 전송
  state.ws.send(
    JSON.stringify({
      type: "register",
      userId: String(state.userId),
    })
  );
  addLog(`에이전트 등록 요청 (userId: ${state.userId})`, "info");

  // 30초 간격으로 하트비트 전송하여 연결 유지
  state.heartbeatTimer = setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(
        JSON.stringify({
          type: "heartbeat",
          userId: String(state.userId),
          payload: { timestamp: Date.now() },
        })
      );
      send("agent:heartbeat", { timestamp: Date.now() });
    }
  }, 30_000);

  send("agent:status", { connected: true });
  updateTray(true);
}

/**
 * WebSocket message 이벤트: 수신 메시지를 파싱하여 타입별로 라우팅
 * @param {Buffer | string} raw - 수신된 원시 데이터
 */
function _onMessage(raw) {
  try {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "register" && msg.success) {
      addLog("에이전트 등록 완료", "success");
    } else if (msg.type === "sign_request") {
      addLog("인증서 서명 요청 수신", "info");
      handleSignRequest(msg.payload || msg);
    } else if (msg.type === "ecfs_login") {
      addLog("전자소송 인증서 로그인 요청 수신", "info");
      handleEcfsLogin(msg.payload || msg).catch((e) =>
        addLog(`ECFS 로그인 처리 오류: ${e.message}`, "error")
      );
    } else if (msg.type === "efiling_submit") {
      addLog(`전자소송 제출 요청 수신 (초안 #${msg.draftId})`, "info");
      handleEfilingSubmit(msg);
    } else if (msg.type === "error") {
      addLog(`서버 오류: ${msg.message}`, "error");
    }
  } catch (err) {
    addLog(`메시지 파싱 오류: ${err.message}`, "error");
  }
}

/**
 * WebSocket close 이벤트: 하트비트 정리 및 비정상 종료 시 재연결 예약
 * @param {number} code - WebSocket 종료 코드 (1000 = 정상)
 * @param {string} serverUrl - 재연결할 서버 URL
 */
function _onClose(code, serverUrl) {
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;

  send("agent:status", { connected: false });
  updateTray(false);

  if (code !== 1000) {
    // 비정상 종료: 5초 후 자동 재연결
    addLog(`연결 끊김 (code: ${code}). 5초 후 재연결...`, "warning");
    scheduleReconnect(serverUrl);
  } else {
    addLog("연결 종료됨", "info");
  }
}

module.exports = { connectWs, disconnectWs, scheduleReconnect };
