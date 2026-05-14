/**
 * ipc-handlers.js
 * 모든 ipcMain.handle 핸들러를 한곳에 등록합니다.
 * 각 기능 모듈에서 함수를 import하여 연결합니다.
 */

const { ipcMain, dialog } = require("electron");
const path = require("path");
const state = require("./state");
const { send, addLog, decodeJwt } = require("./utils");
const { loadConfig, saveConfig } = require("./config");
const { scanCertificates } = require("./certificate");
const { connectWs, disconnectWs } = require("./websocket");

/**
 * 모든 IPC 핸들러를 등록합니다.
 * app.whenReady() 이후, createWindow() 전에 호출해야 합니다.
 */
function registerIpcHandlers() {
  // ── 로그인 ──────────────────────────────────────────────
  ipcMain.handle("agent:login", async (_ev, email, serverUrl) => {
    try {
      const res = await fetch(`${serverUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = await res.json();

      if (!json.success || !json.data?.token) {
        return { success: false, error: json.error || "로그인 실패" };
      }

      state.authToken = json.data.token;
      const decoded = decodeJwt(state.authToken);
      state.userId = String(decoded.userId);

      // 이메일, 서버 URL, userId를 설정 파일에 저장
      saveConfig({ email, serverUrl, userId: state.userId });

      addLog(`로그인 성공 (${email}, userId: ${state.userId})`, "success");
      return { success: true, userId: state.userId, email };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ── WebSocket 연결 ───────────────────────────────────────
  ipcMain.handle("agent:connect", (_ev, serverUrl) => {
    if (!state.userId) return { success: false, error: "먼저 로그인하세요." };
    connectWs(serverUrl);
    return { success: true };
  });

  // ── WebSocket 연결 해제 ──────────────────────────────────
  ipcMain.handle("agent:disconnect", () => {
    disconnectWs();
    addLog("수동 연결 해제", "info");
    return { success: true };
  });

  // ── 인증서 자동 스캔 ─────────────────────────────────────
  ipcMain.handle("agent:scan-certs", async () => {
    try {
      const certs = scanCertificates();
      return { success: true, certs };
    } catch (err) {
      return { success: false, certs: [], error: err.message };
    }
  });

  // ── 인증서 파일 선택 다이얼로그 ─────────────────────────
  ipcMain.handle("agent:select-cert", async () => {
    const result = await dialog.showOpenDialog(state.mainWindow, {
      title: "인증서 파일 선택",
      filters: [
        { name: "인증서", extensions: ["pfx", "p12", "der"] },
        { name: "모든 파일", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false };
    }
    return { success: true, path: result.filePaths[0] };
  });

  // ── 인증서 설정 저장 ──────────────────────────────────────
  ipcMain.handle("agent:set-cert", (_ev, selectedCert, password) => {
    if (typeof selectedCert === "object" && selectedCert !== null) {
      // 자동 스캔된 인증서 객체로 설정
      state.certPath = selectedCert.certPath;
      state.certKeyPath = selectedCert.keyPath || null;
      state.certFormat = selectedCert.format || "pfx";
      state.certPassword = password;
      addLog(
        `인증서 설정됨: ${selectedCert.subject || selectedCert.fileName} (${state.certFormat.toUpperCase()})`,
        "success"
      );
    } else {
      // 기존 호환: 파일 경로 문자열로 설정
      state.certPath = selectedCert;
      state.certKeyPath = null;
      state.certFormat = "pfx";
      state.certPassword = password;
      addLog(`인증서 설정됨: ${path.basename(selectedCert)}`, "success");
    }
    return { success: true };
  });

  // ── 설정 불러오기 ─────────────────────────────────────────
  ipcMain.handle("agent:get-config", () => {
    return loadConfig();
  });
}

module.exports = { registerIpcHandlers };
