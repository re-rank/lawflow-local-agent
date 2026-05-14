/**
 * signing.js
 * 서버로부터 sign_request를 수신했을 때 인증서로 서명하는 처리
 * NPKI(signCert.der + signPri.key) 및 PFX/P12 형식 모두 지원
 */

const fs = require("fs");
const crypto = require("crypto");
const forge = require("node-forge");
const WebSocket = require("ws");
const state = require("./state");
const { send, addLog } = require("./utils");
const { decryptNpkiPrivateKey } = require("./ecfs-crypto");

/**
 * 서버에서 수신한 sign_request 페이로드를 처리합니다.
 * 인증서로 challengeData에 서명하여 sign_response를 WebSocket으로 전송합니다.
 * @param {object} payload - sign_request 페이로드
 * @param {string} payload.requestId - 요청 식별자
 * @param {string} payload.challengeData - Base64 인코딩된 챌린지 데이터
 */
function handleSignRequest(payload) {
  // 인증서 미설정 시 에러 응답
  if (!state.certPath || !state.certPassword) {
    addLog("인증서가 설정되지 않았습니다. 인증서를 먼저 선택하세요.", "error");
    _sendSignResponse(payload.requestId, false, null, null, "인증서가 설정되지 않았습니다.");
    return;
  }

  try {
    const challengeBuf = Buffer.from(payload.challengeData, "base64");
    let signedData;
    let certDN;

    if (state.certFormat === "npki" && state.certKeyPath) {
      // NPKI 형식: DER 인증서 + 암호화된 개인키 파일
      ({ signedData, certDN } = _signWithNpki(challengeBuf));
    } else {
      // PFX/P12 형식
      ({ signedData, certDN } = _signWithPfx(challengeBuf));
    }

    _sendSignResponse(payload.requestId, true, signedData, certDN, null);
    addLog("인증서 서명 완료", "success");
  } catch (err) {
    addLog(`서명 실패: ${err.message}`, "error");
    _sendSignResponse(payload.requestId, false, null, null, err.message);
  }
}

/**
 * NPKI 방식으로 데이터를 서명합니다.
 * SEED-CBC 순수 JS 구현으로 복호화 후, 복호화된 키를 Node.js crypto로 서명합니다.
 * @param {Buffer} challengeBuf - 서명할 원본 데이터 버퍼
 * @returns {{ signedData: string, certDN: string }}
 */
function _signWithNpki(challengeBuf) {
  // 1. SEED-CBC로 개인키 복호화 → forge RSA 개인키 객체
  const forgePrivateKey = decryptNpkiPrivateKey(state.certKeyPath, state.certPassword);

  // 2. forge 개인키를 암호화되지 않은 PKCS#8 PEM으로 내보내기
  //    → Node.js crypto.createSign이 읽을 수 있는 형식
  const decryptedPem = forge.pki.privateKeyToPem(forgePrivateKey);

  // 3. Node.js crypto로 SHA256 서명
  const nodeKey  = crypto.createPrivateKey({ key: decryptedPem, format: "pem" });
  const sign     = crypto.createSign("SHA256");
  sign.update(challengeBuf);
  const signedData = sign.sign(nodeKey, "base64");

  // 4. 인증서에서 DN(Distinguished Name) 추출
  let certDN = "NPKI Certificate";
  try {
    const certDer = fs.readFileSync(state.certPath);
    const x509    = new crypto.X509Certificate(certDer);
    certDN = x509.subject;
  } catch {
    // X509 파싱 실패 시 기본값 유지
  }

  return { signedData, certDN };
}

/**
 * PFX/P12 방식으로 데이터를 서명합니다.
 * @param {Buffer} challengeBuf - 서명할 원본 데이터 버퍼
 * @returns {{ signedData: string, certDN: string }}
 */
function _signWithPfx(challengeBuf) {
  const pfxBuf = fs.readFileSync(state.certPath);

  const key = crypto.createPrivateKey({
    key: pfxBuf,
    format: "pkcs12",
    passphrase: state.certPassword,
  });

  const sign = crypto.createSign("SHA256");
  sign.update(challengeBuf);
  const signedData = sign.sign(key, "base64");

  // PFX에서 공개키를 추출하여 DN 대용으로 사용
  const cert = crypto.createPublicKey({
    key: pfxBuf,
    format: "pkcs12",
    passphrase: state.certPassword,
  });
  const certDN = cert.export({ type: "spki", format: "pem" }).toString().substring(0, 100);

  return { signedData, certDN };
}

/**
 * sign_response 메시지를 WebSocket을 통해 서버에 전송합니다.
 * @param {string} requestId - 요청 ID
 * @param {boolean} success - 서명 성공 여부
 * @param {string | null} signedData - Base64 서명 데이터
 * @param {string | null} certificateDN - 인증서 DN
 * @param {string | null} error - 에러 메시지
 */
function _sendSignResponse(requestId, success, signedData, certificateDN, error) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    addLog("서명 응답 전송 실패: 서버와 연결이 끊어져 있습니다.", "error");
    return;
  }
  try {
    state.ws.send(
      JSON.stringify({
        type: "sign_response",
        userId: String(state.userId),
        payload: { requestId, success, signedData, certificateDN, error },
      })
    );
  } catch (err) {
    addLog(`서명 응답 전송 오류: ${err.message}`, "error");
  }
}

/**
 * 챌린지 데이터에 인증서로 서명합니다 (WebSocket 전송 없이 결과만 반환).
 * ecfs-login.js 등 다른 모듈에서 재사용합니다.
 * @param {Buffer} challengeBuf - 서명할 원본 데이터 버퍼
 * @returns {{ signedData: string, certDN: string }}
 * @throws {Error} 인증서 미설정 또는 서명 실패 시
 */
function signData(challengeBuf) {
  if (!state.certPath || !state.certPassword) {
    throw new Error("인증서가 설정되지 않았습니다.");
  }

  if (state.certFormat === "npki" && state.certKeyPath) {
    return _signWithNpki(challengeBuf);
  }
  return _signWithPfx(challengeBuf);
}

/**
 * 인증서 DER 파일을 Base64 문자열로 반환합니다.
 * @returns {string} Base64 인코딩된 인증서 DER
 */
function getCertBase64() {
  return fs.readFileSync(state.certPath).toString("base64");
}

module.exports = { handleSignRequest, signData, getCertBase64 };
