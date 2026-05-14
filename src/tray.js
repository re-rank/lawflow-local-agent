/**
 * tray.js
 * 시스템 트레이 아이콘 생성 및 관리
 */

const { Tray, Menu, nativeImage, app } = require("electron");
const state = require("./state");

/**
 * 연결 상태에 따라 16x16 트레이 아이콘 이미지를 생성합니다.
 * 연결됨: 파란색 원, 미연결: 회색 원
 * @param {boolean} connected - WebSocket 연결 여부
 * @returns {import('electron').NativeImage}
 */
function createTrayImage(connected) {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);

  const cx = 7.5;
  const cy = 7.5;
  const r = 6;
  // 연결됨: blue-600(#2563EB), 미연결: gray-400(#9CA3AF)
  const color = connected ? [37, 99, 235] : [156, 163, 175];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= r) {
        buf[idx] = color[0];
        buf[idx + 1] = color[1];
        buf[idx + 2] = color[2];
        buf[idx + 3] = 255; // 완전 불투명
      }
    }
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

/**
 * 트레이 아이콘과 툴팁을 연결 상태에 맞게 갱신합니다.
 * @param {boolean} connected - WebSocket 연결 여부
 */
function updateTray(connected) {
  if (state.tray) {
    state.tray.setImage(createTrayImage(connected));
    state.tray.setToolTip(
      connected ? "LawFlow Agent - 연결됨" : "LawFlow Agent - 미연결"
    );
  }
}

/**
 * 시스템 트레이를 생성하고 컨텍스트 메뉴를 등록합니다.
 * disconnectWs를 순환 의존 없이 사용하기 위해 함수 인수로 받습니다.
 * @param {Function} disconnectWs - WebSocket 연결 해제 함수
 */
function createTray(disconnectWs) {
  state.tray = new Tray(createTrayImage(false));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "열기",
      click: () => {
        state.mainWindow.show();
        state.mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: "종료",
      click: () => {
        app.isQuitting = true;
        disconnectWs();
        app.quit();
      },
    },
  ]);

  state.tray.setToolTip("LawFlow Agent");
  state.tray.setContextMenu(contextMenu);

  // 더블클릭 시 창 표시
  state.tray.on("double-click", () => {
    state.mainWindow.show();
    state.mainWindow.focus();
  });
}

module.exports = { createTrayImage, updateTray, createTray };
