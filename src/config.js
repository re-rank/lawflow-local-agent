/**
 * config.js
 * 앱 설정 파일(config.json) 읽기/쓰기 처리
 * userData 디렉토리에 저장됩니다.
 */

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

/**
 * config.json 파일의 절대 경로를 반환합니다.
 * @returns {string}
 */
function getConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

/**
 * 저장된 설정을 불러옵니다. 파일이 없거나 파싱 실패 시 빈 객체를 반환합니다.
 * @returns {object}
 */
function loadConfig() {
  try {
    const p = getConfigPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    // 설정 파일 로드 실패 시 기본값(빈 객체) 반환
  }
  return {};
}

/**
 * 설정 객체를 config.json에 저장합니다.
 * @param {object} cfg - 저장할 설정 객체
 */
function saveConfig(cfg) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2));
}

module.exports = { getConfigPath, loadConfig, saveConfig };
