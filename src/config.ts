/**
 * 로컬 에이전트 설정
 *
 * 우선순위: 환경변수 > 저장된 설정파일 > 기본값
 * 설정파일 경로: ~/.lawflow/config.json
 */

import path from 'path';
import os from 'os';
import fs from 'fs';

/** 프로덕션 서버 WebSocket URL */
const DEFAULT_SERVER_URL = 'wss://backendlawauto-production.up.railway.app/ws/agent';

export interface AgentConfig {
  /** 클라우드 백엔드 WebSocket URL */
  serverUrl: string;
  /** 사용자 ID (백엔드 register 시 사용) */
  userId: string;
  /** 인증서 저장소 경로 (자동 탐지 또는 수동 지정) */
  certStorePath: string;
  /** 재연결 간격 (ms) */
  reconnectInterval: number;
  /** 하트비트 간격 (ms) */
  heartbeatInterval: number;
}

interface SavedConfig {
  userId?: string;
  serverUrl?: string;
  certStorePath?: string;
}

/**
 * 설정파일 디렉토리 경로 (~/.lawflow)
 */
function getConfigDir(): string {
  return path.join(os.homedir(), '.lawflow');
}

/**
 * 설정파일 경로 (~/.lawflow/config.json)
 */
function getConfigFilePath(): string {
  return path.join(getConfigDir(), 'config.json');
}

/**
 * NPKI 인증서 기본 저장 경로 반환 (OS별)
 */
function getDefaultCertPath(): string {
  const platform = os.platform();
  const home = os.homedir();

  switch (platform) {
    case 'win32':
      return path.join(home, 'AppData', 'LocalLow', 'NPKI');
    case 'darwin':
      return path.join(home, 'Library', 'Preferences', 'NPKI');
    case 'linux':
      return path.join(home, 'NPKI');
    default:
      return path.join(home, 'NPKI');
  }
}

/**
 * 저장된 설정 파일 읽기
 */
function loadSavedConfig(): SavedConfig {
  const configPath = getConfigFilePath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(raw) as SavedConfig;
    }
  } catch {
    // 파일 읽기 실패 시 무시
  }
  return {};
}

/**
 * 설정을 파일에 저장
 */
export function saveUserConfig(userId: string, serverUrl?: string): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const existing = loadSavedConfig();
  const config: SavedConfig = {
    ...existing,
    userId,
  };
  if (serverUrl) {
    config.serverUrl = serverUrl;
  }

  fs.writeFileSync(getConfigFilePath(), JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * 설정 로드 (userId가 비어 있을 수 있음 — 호출자가 처리)
 *
 * 우선순위: 환경변수 > 저장된 config.json > 기본값
 */
export function loadConfig(): AgentConfig {
  const saved = loadSavedConfig();

  const serverUrl =
    process.env.LAWFLOW_SERVER_URL || saved.serverUrl || DEFAULT_SERVER_URL;
  const userId =
    process.env.LAWFLOW_USER_ID || saved.userId || '';
  const certStorePath =
    process.env.LAWFLOW_CERT_PATH || saved.certStorePath || getDefaultCertPath();

  return {
    serverUrl,
    userId,
    certStorePath,
    reconnectInterval: 5000,
    heartbeatInterval: 30000,
  };
}
