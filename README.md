# LawFlow 로컬 에이전트

## 개요

전자소송(ecfs.scourt.go.kr) 인증서 로그인을 위한 로컬 브릿지 에이전트.
공동인증서(NPKI)는 사용자 PC에만 존재하므로, 클라우드 백엔드가 직접 접근할 수 없습니다.
이 에이전트가 그 중간 다리 역할을 합니다.

## 아키텍처

```
┌────────────────┐     ┌──────────────┐     ┌──────────────┐
│ ecfs.scourt.go │◄───►│ 클라우드 백엔드 │◄──►│  로컬 에이전트 │
│ .kr (전자소송)  │     │  (Railway)    │ WS  │  (사용자 PC)  │
└────────────────┘     └──────────────┘     └──────┬───────┘
                                                    │
                                             ┌──────▼───────┐
                                             │ NPKI 인증서   │
                                             │ (signCert.der │
                                             │  signPri.key) │
                                             └──────────────┘
```

## 인증 흐름

1. 사용자가 웹앱에서 "전자소송 연동" 클릭
2. 백엔드가 ecfs.scourt.go.kr 로그인 페이지에서 챌린지 데이터 수집
3. 백엔드가 WebSocket으로 로컬 에이전트에 서명 요청 전송
4. 로컬 에이전트가 사용자에게 인증서 비밀번호 입력 요청 (웹앱 UI)
5. 사용자가 비밀번호 입력
6. 로컬 에이전트가 개인키로 챌린지 데이터에 전자서명
7. 서명 결과를 백엔드로 반환
8. 백엔드가 서명된 데이터로 ecfs 로그인 완료
9. 이후 세션 유지하며 사건 데이터 크롤링

## 설치 및 실행

```bash
# 의존성 설치
npm install

# 개발 모드 실행
npm run dev

# 빌드
npm run build

# 실행 파일 패키징 (배포용)
npm run package:win   # Windows .exe
npm run package:mac   # macOS
```

## 환경변수

```env
LAWFLOW_SERVER_URL=wss://your-backend.railway.app/ws/agent
LAWFLOW_AUTH_TOKEN=your-jwt-token
LAWFLOW_CERT_PATH=C:\Users\{user}\AppData\LocalLow\NPKI  # 선택사항 (자동감지)
```

## 보안 고려사항

- 인증서 비밀번호는 메모리에서만 처리, 디스크에 저장하지 않음
- 개인키는 로컬에서만 접근, 네트워크로 전송하지 않음
- WebSocket 통신은 TLS(WSS)로 암호화
- JWT 토큰으로 에이전트 인증
- 서명 요청마다 사용자 비밀번호 확인 (자동 서명 방지)

## NPKI 인증서 경로

| OS | 경로 |
|----|------|
| Windows | `C:\Users\{user}\AppData\LocalLow\NPKI\` |
| macOS | `~/Library/Preferences/NPKI/` |
| USB | `{드라이브}:\NPKI\` |

## 한국 암호 알고리즘 참고

한국 NPKI 개인키는 SEED-CBC-128 또는 ARIA-CBC-256으로 암호화되어 있습니다.
Node.js 네이티브로는 지원하지 않으므로 추가 라이브러리가 필요합니다:

- SEED: OpenSSL 바인딩 또는 KISA 제공 구현체
- ARIA: OpenSSL 1.1.1+ (지원), 또는 별도 구현

프로덕션 배포 시 반드시 이 부분을 구현해야 합니다.
