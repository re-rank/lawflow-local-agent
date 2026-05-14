/**
 * state.js
 * 앱 전역 공유 상태 객체
 * 모든 모듈이 이 객체를 import하여 상태를 읽고 씁니다.
 */

const state = {
  /** @type {import('electron').BrowserWindow | null} */
  mainWindow: null,

  /** @type {import('electron').Tray | null} */
  tray: null,

  /** @type {import('ws') | null} WebSocket 인스턴스 */
  ws: null,

  /** @type {NodeJS.Timeout | null} 하트비트 인터벌 타이머 */
  heartbeatTimer: null,

  /** @type {NodeJS.Timeout | null} 재연결 딜레이 타이머 */
  reconnectTimer: null,

  /** @type {string | null} 로그인된 사용자 ID */
  userId: null,

  /** @type {string | null} JWT 인증 토큰 */
  authToken: null,

  /** @type {string | null} 선택된 인증서 파일 경로 (certPath 또는 pfx 경로) */
  certPath: null,

  /** @type {string | null} 인증서 비밀번호 */
  certPassword: null,

  /** @type {string | null} NPKI 개인키 경로 (signPri.key) */
  certKeyPath: null,

  /** @type {"pfx" | "npki" | null} 인증서 형식 */
  certFormat: null,
};

module.exports = state;
