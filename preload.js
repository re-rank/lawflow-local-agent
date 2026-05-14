const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  // 렌더러 → 메인
  login: (email, serverUrl) =>
    ipcRenderer.invoke("agent:login", email, serverUrl),
  connect: (serverUrl) => ipcRenderer.invoke("agent:connect", serverUrl),
  disconnect: () => ipcRenderer.invoke("agent:disconnect"),
  scanCerts: () => ipcRenderer.invoke("agent:scan-certs"),
  selectCert: () => ipcRenderer.invoke("agent:select-cert"),
  setCert: (certOrPath, password) =>
    ipcRenderer.invoke("agent:set-cert", certOrPath, password),
  getConfig: () => ipcRenderer.invoke("agent:get-config"),

  // 메인 → 렌더러 이벤트 리스너
  onStatus: (cb) => ipcRenderer.on("agent:status", (_ev, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on("agent:log", (_ev, d) => cb(d)),
  onHeartbeat: (cb) => ipcRenderer.on("agent:heartbeat", (_ev, d) => cb(d)),
  onEfilingStatus: (cb) => ipcRenderer.on("agent:efiling-status", (_ev, d) => cb(d)),
  onUpdateStatus: (cb) => ipcRenderer.on("update-status", (_ev, d) => cb(d)),
});
