/**
 * certificate.js
 * 시스템 공동인증서(NPKI) 및 PFX/P12 파일 자동 탐색 및 파싱 처리
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

/**
 * 시스템에 설치된 공동인증서(NPKI) 및 pfx/p12 파일을 자동 탐색합니다.
 * Windows: %USERPROFILE%\AppData\LocalLow\NPKI 및 USB 드라이브 포함
 * @returns {Array<object>} 탐색된 인증서 정보 목록
 */
function scanCertificates() {
  const results = [];
  const home = os.homedir();

  // 1. NPKI 디렉토리 목록 구성 (AppData 하위 폴더 3곳 + 벤더별 저장소)
  const npkiDirs = [
    path.join(home, "AppData", "LocalLow", "NPKI"),
    path.join(home, "AppData", "Local", "NPKI"),
    path.join(home, "AppData", "Roaming", "NPKI"),
    // SoftForum (XecureWeb) 인증서 저장소
    path.join(home, "AppData", "LocalLow", "SoftForum", "certstorage"),
    // CrossCert (KeySharp) 인증서 저장소
    path.join(home, "AppData", "LocalLow", "CrossCert"),
    // KICA 인증서 저장소
    path.join(home, "AppData", "LocalLow", "KICA"),
    // SignKorea 인증서 저장소
    path.join(home, "AppData", "LocalLow", "SignKorea"),
  ];

  // USB 드라이브 탐색: D: ~ Z: 드라이브의 NPKI 폴더
  for (let code = 68; code <= 90; code++) {
    const drive = String.fromCharCode(code) + ":\\NPKI";
    npkiDirs.push(drive);
  }

  for (const npkiDir of npkiDirs) {
    scanNpkiDir(npkiDir, results);
  }

  // 2. 홈 디렉토리 및 일반적인 위치에서 pfx/p12 파일 탐색
  const pfxSearchDirs = [
    home,
    path.join(home, "Desktop"),
    path.join(home, "Downloads"),
    path.join(home, "Documents"),
  ];

  for (const dir of pfxSearchDirs) {
    scanPfxDir(dir, results);
  }

  return results;
}

/**
 * NPKI 디렉토리를 재귀적으로 탐색하여 signCert.der + signPri.key 쌍을 찾습니다.
 * @param {string} dirPath - 탐색할 디렉토리 경로
 * @param {Array<object>} results - 결과를 누적할 배열
 */
function scanNpkiDir(dirPath, results) {
  try {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // 하위 디렉토리 재귀 탐색
        scanNpkiDir(fullPath, results);
      } else if (entry.name === "signCert.der") {
        const keyPath = path.join(dirPath, "signPri.key");
        if (fs.existsSync(keyPath)) {
          try {
            const certInfo = parseNpkiCert(fullPath, keyPath);
            if (certInfo) results.push(certInfo);
          } catch {
            // 파싱 실패한 인증서는 건너뜀
          }
        }
      }
    }
  } catch {
    // 접근 권한 없는 디렉토리 건너뜀
  }
}

/**
 * 특정 디렉토리에서 pfx/p12 파일을 탐색합니다 (1단계만, 재귀하지 않음).
 * @param {string} dirPath - 탐색할 디렉토리 경로
 * @param {Array<object>} results - 결과를 누적할 배열
 */
function scanPfxDir(dirPath, results) {
  try {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && /\.(pfx|p12)$/i.test(entry.name)) {
        const fullPath = path.join(dirPath, entry.name);
        results.push({
          format: "pfx",
          subject: entry.name.replace(/\.(pfx|p12)$/i, ""),
          issuer: "-",
          validFrom: "-",
          validTo: "-",
          certPath: fullPath,
          keyPath: null,
          fileName: entry.name,
          location: dirPath,
        });
      }
    }
  } catch {
    // 접근 권한 없는 디렉토리 건너뜀
  }
}

/**
 * NPKI DER 형식 인증서를 파싱하여 메타데이터를 추출합니다.
 * Node.js 내장 X509Certificate를 사용합니다.
 * @param {string} certFilePath - signCert.der 파일 경로
 * @param {string} keyFilePath - signPri.key 파일 경로
 * @returns {object | null} 파싱된 인증서 정보 객체
 */
function parseNpkiCert(certFilePath, keyFilePath) {
  const derBuf = fs.readFileSync(certFilePath);
  let subject = "알 수 없는 소유자";
  let issuer = "알 수 없는 발급기관";
  let validFrom = "-";
  let validTo = "-";

  try {
    const x509 = new crypto.X509Certificate(derBuf);

    // CN 필드에서 소유자 이름 추출 (예: "CN=홍길동,OU=...,O=...")
    const cnMatch = x509.subject.match(/CN=([^,\n]+)/);
    subject = cnMatch ? cnMatch[1] : x509.subject.split("\n")[0] || subject;

    const issuerCnMatch = x509.issuer.match(/CN=([^,\n]+)/);
    issuer = issuerCnMatch ? issuerCnMatch[1] : x509.issuer.split("\n")[0] || issuer;

    // 날짜는 앞 10자리(YYYY-MM-DD)만 사용
    validFrom = x509.validFrom.substring(0, 10);
    validTo = x509.validTo.substring(0, 10);
  } catch {
    // X509Certificate 파싱 실패 시 상위 디렉토리명을 소유자로 사용
    const parentDir = path.basename(path.dirname(certFilePath));
    subject = parentDir || subject;
  }

  // 인증기관(CA) 폴더명 추출: NPKI 바로 아래 폴더가 CA 이름
  const certDir = path.dirname(certFilePath);
  const parts = certDir.split(path.sep);
  const npkiIdx = parts.findIndex((p) => p === "NPKI");
  const caName = npkiIdx >= 0 && npkiIdx + 1 < parts.length ? parts[npkiIdx + 1] : "";

  return {
    format: "npki",
    subject,
    issuer: caName || issuer,
    validFrom,
    validTo,
    certPath: certFilePath,
    keyPath: keyFilePath,
    fileName: `signCert.der (${subject})`,
    location: certDir,
  };
}

module.exports = { scanCertificates, scanNpkiDir, scanPfxDir, parseNpkiCert };
