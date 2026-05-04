/**
 * WebSocket 브릿지 - 클라우드 백엔드와 로컬 에이전트 간 통신
 *
 * 백엔드 프로토콜:
 * - 연결 시: { type: 'register', userId }
 * - 서버 → 에이전트: { type: 'sign_request', userId, payload: CertificateAuthRequest }
 * - 에이전트 → 서버: { type: 'sign_response', userId, payload: CertificateAuthResponse }
 * - 에이전트 → 서버: { type: 'heartbeat', userId, payload: {} }
 */

import WebSocket from 'ws';
import readline from 'readline';
import { AgentConfig } from './config';
import { CertificateManager, CertificateInfo } from './certificate-manager';

interface CertificateAuthRequest {
  requestId: string;
  userId: string;
  challengeData: string;
  timestamp: number;
  expiresIn: number;
}

interface CertificateAuthResponse {
  requestId: string;
  success: boolean;
  signedData: string | null;
  certificateDN: string | null;
  error: string | null;
}

interface IncomingMessage {
  type: string;
  userId?: string;
  success?: boolean;
  message?: string;
  payload?: CertificateAuthRequest;
}

export class WebSocketBridge {
  private ws: WebSocket | null = null;
  private config: AgentConfig;
  private certManager: CertificateManager;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected = false;
  private isShuttingDown = false;

  /** 활성 인증서 (index.ts에서 설정) */
  private activeCert: CertificateInfo | null = null;

  /** 활성 인증서 비밀번호 (index.ts에서 설정) */
  private activePassword: string = '';

  constructor(config: AgentConfig, certManager: CertificateManager) {
    this.config = config;
    this.certManager = certManager;
  }

  /**
   * 사용할 인증서와 비밀번호 설정
   */
  setCertificate(cert: CertificateInfo, password: string): void {
    this.activeCert = cert;
    this.activePassword = password;
  }

  /**
   * 백엔드 WebSocket 서버에 연결
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.config.serverUrl;
      console.log(`[WS] 연결 중: ${url}`);

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.isConnected = true;
        console.log('[WS] 연결 완료. 에이전트 등록 중...');

        // 백엔드 프로토콜: register 메시지 전송
        this.sendRaw({ type: 'register', userId: this.config.userId });
        this.startHeartbeat();
        resolve();
      });

      this.ws.on('error', (err) => {
        if (!this.isConnected) {
          reject(err);
        } else {
          console.error('[WS] 연결 오류:', err.message);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this.stopHeartbeat();
        console.log(
          `[WS] 연결 종료 (code: ${code}, reason: ${reason.toString() || '없음'})`
        );
        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /**
   * 메시지 수신 리스너 시작
   */
  startListening(): void {
    if (!this.ws) return;

    this.ws.on('message', async (data) => {
      try {
        const message: IncomingMessage = JSON.parse(data.toString());
        await this.handleMessage(message);
      } catch (err) {
        console.error('[WS] 메시지 파싱 실패:', err);
      }
    });
  }

  /**
   * 수신 메시지 처리
   */
  private async handleMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'register':
        if (message.success) {
          console.log('[에이전트] 등록 완료:', message.message);
        } else {
          console.error('[에이전트] 등록 실패:', message.message);
        }
        break;

      case 'sign_request':
        await this.handleSignRequest(message);
        break;

      case 'heartbeat':
        // 하트비트 응답은 별도로 보낼 필요 없음 (에이전트가 주기적으로 보냄)
        break;

      case 'error':
        console.error('[서버] 에러 메시지:', message.message);
        break;

      default:
        console.warn('[WS] 알 수 없는 메시지 타입:', message.type);
    }
  }

  /**
   * 서명 요청 처리
   */
  private async handleSignRequest(message: IncomingMessage): Promise<void> {
    const payload = message.payload;
    if (!payload) {
      console.error('[서명] 페이로드 없음');
      return;
    }

    const { requestId, challengeData } = payload;
    console.log(`\n[서명] 서명 요청 수신 (requestId: ${requestId})`);

    // 활성 인증서 확인
    if (!this.activeCert) {
      this.sendSignResponse({
        requestId,
        success: false,
        signedData: null,
        certificateDN: null,
        error: '활성 인증서가 없습니다. 에이전트를 재시작하세요.',
      });
      return;
    }

    // 인증서 유효성 검사
    const validation = this.certManager.validateCertificate(this.activeCert);
    if (!validation.valid) {
      this.sendSignResponse({
        requestId,
        success: false,
        signedData: null,
        certificateDN: null,
        error: validation.reason ?? '인증서 유효성 검사 실패',
      });
      return;
    }

    // 비밀번호가 없으면 readline으로 입력받기
    let password = this.activePassword;
    if (!password) {
      password = await this.promptPassword(this.activeCert.subject);
      this.activePassword = password;
    }

    try {
      const signResult = await this.certManager.signData(
        this.activeCert,
        challengeData,
        password
      );

      // 비밀번호 오류 감지 후 재시도
      this.sendSignResponse({
        requestId,
        success: true,
        signedData: signResult.signedData,
        certificateDN: signResult.certificateDN,
        error: null,
      });

      console.log(`[서명] 서명 완료 (requestId: ${requestId})`);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : '서명 중 오류 발생';

      // 비밀번호 오류이면 캐시 초기화
      if (
        errorMessage.includes('비밀번호') ||
        errorMessage.includes('password') ||
        errorMessage.includes('decrypt')
      ) {
        this.activePassword = '';
        console.error('[서명] 비밀번호 오류 - 다음 요청 시 재입력 필요');
      }

      this.sendSignResponse({
        requestId,
        success: false,
        signedData: null,
        certificateDN: null,
        error: errorMessage,
      });

      console.error(`[서명] 서명 실패: ${errorMessage}`);
    }
  }

  /**
   * readline으로 비밀번호 입력
   */
  private promptPassword(certSubject: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      // 비밀번호 입력 시 에코 비활성화
      const origWrite = (rl as unknown as { output: { write: (s: string) => void } }).output.write.bind(
        (rl as unknown as { output: { write: (s: string) => void } }).output
      );
      (rl as unknown as { output: { write: (s: string) => boolean } }).output.write = (chunk: string) => {
        // 프롬프트 메시지는 출력하되 입력 내용은 에코하지 않음
        if (!chunk.match(/^[^\n\r]+$/) || chunk.includes('비밀번호')) {
          origWrite(chunk);
        }
        return true;
      };

      rl.question(
        `[서명] "${certSubject}" 인증서 비밀번호를 입력하세요: `,
        (answer) => {
          rl.close();
          // 개행 후 실제 입력 내용 줄 정리
          process.stdout.write('\n');
          resolve(answer);
        }
      );
    });
  }

  /**
   * sign_response 전송
   */
  private sendSignResponse(response: CertificateAuthResponse): void {
    this.sendRaw({
      type: 'sign_response',
      userId: this.config.userId,
      payload: response,
    });
  }

  /**
   * 원시 메시지 전송
   */
  private sendRaw(message: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[WS] 연결되지 않은 상태에서 전송 시도');
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * 하트비트 시작
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.sendRaw({
        type: 'heartbeat',
        userId: this.config.userId,
        payload: {},
      });
    }, this.config.heartbeatInterval);
  }

  /**
   * 하트비트 중지
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 재연결 예약
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    console.log(
      `[WS] ${this.config.reconnectInterval / 1000}초 후 재연결 시도...`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        this.startListening();
        console.log('[WS] 재연결 성공');
      } catch (err) {
        console.error('[WS] 재연결 실패:', err instanceof Error ? err.message : err);
        this.scheduleReconnect();
      }
    }, this.config.reconnectInterval);
  }

  /**
   * 연결 해제
   */
  disconnect(): void {
    this.isShuttingDown = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Agent shutdown');
      this.ws = null;
    }
    this.isConnected = false;
  }

  /**
   * 연결 상태 확인
   */
  getConnectionStatus(): boolean {
    return this.isConnected;
  }
}
