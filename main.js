/**
 * main.js
 * Electron 앱 진입점 - 라이프사이클 관리만 담당합니다.
 * 비즈니스 로직은 모두 src/ 하위 모듈에 위임합니다.
 */

const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const { autoUpdater } = require("electron-updater");

const state = require("./src/state");
const { registerIpcHandlers } = require("./src/ipc-handlers");
const { createTray } = require("./src/tray");
const { disconnectWs, connectWs } = require("./src/websocket");
const { loadConfig } = require("./src/config");
const { addLog, decodeJwt } = require("./src/utils");

/**
 * 메인 브라우저 창을 생성하고 state.mainWindow에 등록합니다.
 */
function createWindow() {
  state.mainWindow = new BrowserWindow({
    width: 460,
    height: 680,
    minWidth: 400,
    minHeight: 600,
    resizable: true,
    title: "LawFlow Agent",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  state.mainWindow.loadFile("index.html");

  // 닫기(X) 버튼 클릭 시 종료하지 않고 트레이로 최소화
  state.mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      state.mainWindow.hide();
    }
  });
}

// ── 자동 업데이트 ────────────────────────────────────────

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    addLog("업데이트 확인 중...", "info");
  });

  autoUpdater.on("update-not-available", (info) => {
    addLog(`최신 버전입니다 (v${info.version})`, "info");
  });

  autoUpdater.on("update-available", (info) => {
    addLog(`새 버전 발견: v${info.version}`, "info");

    // 앱 실행 시 즉시 업데이트 팝업 표시
    dialog
      .showMessageBox(state.mainWindow, {
        type: "info",
        title: "업데이트 알림",
        message: `LawFlow Agent 새 버전이 있습니다.`,
        detail: `현재 버전: v${app.getVersion()}\n최신 버전: v${info.version}\n\n지금 업데이트하시겠습니까?`,
        buttons: ["업데이트", "나중에"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          addLog(`v${info.version} 다운로드 시작...`, "info");
          if (state.mainWindow) {
            state.mainWindow.webContents.send("update-status", {
              status: "downloading",
              version: info.version,
            });
          }
          autoUpdater.downloadUpdate();
        }
      });
  });

  autoUpdater.on("download-progress", (progress) => {
    const pct = Math.round(progress.percent);
    if (state.mainWindow) {
      state.mainWindow.webContents.send("update-status", {
        status: "downloading",
        percent: pct,
      });
      state.mainWindow.setProgressBar(pct / 100);
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    addLog(`업데이트 다운로드 완료: v${info.version}`, "success");
    if (state.mainWindow) {
      state.mainWindow.setProgressBar(-1); // 프로그레스 바 제거
      state.mainWindow.webContents.send("update-status", {
        status: "ready",
        version: info.version,
      });
    }
    dialog
      .showMessageBox(state.mainWindow, {
        type: "info",
        title: "업데이트 준비 완료",
        message: `LawFlow Agent v${info.version} 업데이트가 준비되었습니다.\n지금 재시작하시겠습니까?`,
        buttons: ["지금 재시작", "나중에"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          app.isQuitting = true;
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on("error", (err) => {
    addLog(`자동 업데이트 오류: ${err.message}`, "error");
    if (state.mainWindow) {
      state.mainWindow.setProgressBar(-1);
    }
  });

  // 앱 시작 후 업데이트 확인
  autoUpdater.checkForUpdates().catch((e) => {
    addLog(`업데이트 확인 실패: ${e.message}`, "warning");
  });
}

// ── Electron 라이프사이클 ────────────────────────────────

app.whenReady().then(async () => {
  registerIpcHandlers();
  createWindow();
  createTray(disconnectWs);
  setupAutoUpdater();

  // 저장된 설정이 있으면 자동 로그인 + WebSocket 연결
  try {
    const cfg = loadConfig();
    if (cfg.email && cfg.serverUrl) {
      addLog(`자동 연결 시도: ${cfg.email}`, "info");
      const res = await fetch(`${cfg.serverUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cfg.email }),
      });
      const json = await res.json();
      if (json.success && json.data?.token) {
        state.authToken = json.data.token;
        const decoded = decodeJwt(state.authToken);
        state.userId = String(decoded.userId);
        addLog(`자동 로그인 성공 (userId: ${state.userId})`, "success");
        connectWs(cfg.serverUrl);
      } else {
        addLog(`자동 로그인 실패: ${json.error || "알 수 없는 오류"}`, "warning");
      }
    }
  } catch (err) {
    addLog(`자동 연결 오류: ${err.message}`, "warning");
  }
});

app.on("window-all-closed", () => {
  // macOS 외 플랫폼에서는 모든 창이 닫혀도 앱을 종료하지 않음 (트레이 상주)
});

app.on("activate", () => {
  // macOS: dock 아이콘 클릭 시 창 다시 표시
  if (state.mainWindow) {
    state.mainWindow.show();
    state.mainWindow.focus();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  disconnectWs();
});
