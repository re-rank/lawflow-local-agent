/**
 * LawFlow 로컬 에이전트 - 메인 진입점
 *
 * 역할:
 * 1. 사용자 PC의 공동인증서(NPKI)에 접근하여 전자서명 수행
 * 2. WebSocket으로 클라우드 백엔드와 통신
 * 3. 전자소송(ecfs.scourt.go.kr) 인증 브릿지
 *
 * 흐름:
 * [클라우드 백엔드] <--WebSocket--> [로컬 에이전트] <--로컬 파일시스템--> [공동인증서]
 */

import readline from 'readline';
import { CertificateManager, CertificateInfo } from './certificate-manager';
import { WebSocketBridge } from './websocket-bridge';
import { AgentConfig, loadConfig, saveUserConfig } from './config';

/**
 * readline으로 한 줄 입력 받기
 */
function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * readline으로 비밀번호 입력 받기 (에코 없음)
 */
function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    // stdin이 TTY인 경우에만 에코 비활성화
    if (process.stdin.isTTY) {
      process.stdout.write(question);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      let password = '';
      const onData = (char: string) => {
        if (char === '\n' || char === '\r' || char === '\u0003') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(password);
        } else if (char === '\u007F' || char === '\b') {
          // 백스페이스
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          password += char;
          process.stdout.write('*');
        }
      };
      process.stdin.on('data', onData);
    } else {
      // TTY가 아닌 경우 (파이프 등) 일반 readline 사용
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

class LawFlowAgent {
  private config: AgentConfig;
  private certManager: CertificateManager;
  private wsBridge!: WebSocketBridge;
  private isRunning = false;

  constructor() {
    this.config = loadConfig();
    this.certManager = new CertificateManager();
  }

  async start(): Promise<void> {
    console.log('========================================');
    console.log('  LawFlow 로컬 에이전트 v0.1.0');
    console.log('  공동인증서 브릿지 서비스');
    console.log('========================================\n');

    // 사용자 ID가 없으면 대화형으로 입력 받기
    if (!this.config.userId) {
      console.log('[초기 설정] 사용자 ID가 설정되지 않았습니다.\n');
      console.log('  LawFlow 웹사이트에 로그인한 계정의 ID를 입력하세요.');
      console.log('  (이 설정은 저장되어 다음 실행 시 자동으로 사용됩니다.)\n');

      const userId = await prompt('  사용자 ID: ');
      if (!userId) {
        console.error('\n[오류] 사용자 ID가 입력되지 않았습니다.');
        process.exit(1);
      }

      this.config.userId = userId;
      saveUserConfig(userId, this.config.serverUrl);
      console.log(`\n  설정이 저장되었습니다.\n`);
    }

    // WebSocketBridge 초기화 (userId가 확보된 후)
    this.wsBridge = new WebSocketBridge(this.config, this.certManager);

    console.log(`  사용자 ID: ${this.config.userId}`);
    console.log(`  서버 URL : ${this.config.serverUrl}`);
    console.log(`  인증서 경로: ${this.config.certStorePath}\n`);

    // 1. 인증서 저장소 스캔
    console.log('[1/4] 공동인증서 저장소 검색 중...');
    const certs = await this.certManager.scanCertificates();
    if (certs.length === 0) {
      console.error('[오류] 설치된 공동인증서를 찾을 수 없습니다.');
      console.log('  인증서 경로를 확인해주세요:');
      console.log('  - Windows: C:\\Users\\{사용자}\\AppData\\LocalLow\\NPKI\\');
      console.log('  - Mac: ~/Library/Preferences/NPKI/');
      process.exit(1);
    }
    console.log(`  ${certs.length}개의 인증서를 발견했습니다.\n`);

    // 2. 인증서 선택
    const selectedCert = await this.selectCertificate(certs);
    console.log(`\n  선택된 인증서: ${selectedCert.subject} (${selectedCert.issuer})`);

    // 3. 비밀번호 입력
    console.log('\n[3/4] 인증서 비밀번호 입력');
    const password = await promptPassword(
      `  "${selectedCert.subject}" 비밀번호: `
    );

    if (!password) {
      console.error('[오류] 비밀번호가 입력되지 않았습니다.');
      process.exit(1);
    }

    // 비밀번호 사전 검증 (복호화 테스트)
    console.log('\n  비밀번호 검증 중...');
    try {
      await this.certManager.signData(
        selectedCert,
        Buffer.from('test').toString('base64'),
        password
      );
      console.log('  비밀번호 확인 완료\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[오류] 비밀번호 검증 실패: ${msg}`);
      process.exit(1);
    }

    // WebSocketBridge에 인증서와 비밀번호 설정
    this.wsBridge.setCertificate(selectedCert, password);

    // 4. 백엔드 WebSocket 연결
    console.log('[4/4] 클라우드 서버 연결 중...');
    await this.wsBridge.connect();
    console.log(`  서버 연결 완료: ${this.config.serverUrl}\n`);

    // 메시지 리스너 시작
    this.wsBridge.startListening();
    this.isRunning = true;

    console.log('에이전트가 실행 중입니다. 서명 요청을 대기합니다.');
    console.log('종료하려면 Ctrl+C를 누르세요.\n');

    // 종료 핸들러
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  /**
   * 인증서 선택 (readline 기반)
   */
  private async selectCertificate(
    certs: CertificateInfo[]
  ): Promise<CertificateInfo> {
    console.log('[2/4] 사용할 인증서를 선택하세요:\n');
    certs.forEach((cert, i) => {
      const validation = this.certManager.validateCertificate(cert);
      const status = validation.valid ? '[유효]' : `[무효: ${validation.reason}]`;
      console.log(`  [${i + 1}] ${cert.subject}`);
      console.log(`       발급기관: ${cert.issuer}`);
      console.log(`       유효기간: ${cert.validFrom} ~ ${cert.validTo} ${status}`);
      console.log('');
    });

    // 유효한 인증서가 1개뿐이면 자동 선택
    const validCerts = certs.filter(
      (c) => this.certManager.validateCertificate(c).valid
    );

    if (validCerts.length === 1) {
      console.log(`  유효한 인증서가 1개이므로 자동 선택합니다: ${validCerts[0].subject}`);
      return validCerts[0];
    }

    if (certs.length === 1) {
      console.log(`  인증서가 1개이므로 자동 선택합니다: ${certs[0].subject}`);
      return certs[0];
    }

    // 사용자에게 선택 요청
    const answer = await prompt(`  번호를 입력하세요 (1-${certs.length}): `);
    const index = parseInt(answer, 10) - 1;

    if (isNaN(index) || index < 0 || index >= certs.length) {
      console.log('  잘못된 입력입니다. 첫 번째 인증서를 선택합니다.');
      return certs[0];
    }

    return certs[index];
  }

  private async shutdown(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    console.log('\n에이전트를 종료합니다...');
    this.wsBridge.disconnect();
    process.exit(0);
  }
}

// 실행
const agent = new LawFlowAgent();
agent.start().catch((err) => {
  console.error('에이전트 실행 실패:', err instanceof Error ? err.message : err);
  process.exit(1);
});
