/**
 * 공동인증서(NPKI) 관리 모듈
 *
 * 한국 공동인증서 구조:
 * NPKI/
 *   {인증기관명}/
 *     USER/
 *       {인증서ID}/
 *         signCert.der   - 서명용 인증서 (X.509 DER)
 *         signPri.key    - 서명용 개인키 (암호화됨, PKCS#8 + SEED/ARIA)
 *
 * 개인키 암호화 방식:
 * - SEED-CBC-128 (구형, OID: 1.2.410.200004.1.4)
 * - ARIA-CBC-256 (신형, OID: 1.2.840.113549.1.5.13)
 * - PBKDF1/PBKDF2 기반 키 유도
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import forge from 'node-forge';
import { loadConfig } from './config';

export interface CertificateInfo {
  /** 인증서 소유자 */
  subject: string;
  /** 발급기관 */
  issuer: string;
  /** 유효 시작일 */
  validFrom: string;
  /** 유효 만료일 */
  validTo: string;
  /** 인증서 파일 경로 */
  certPath: string;
  /** 개인키 파일 경로 */
  keyPath: string;
  /** 인증서 시리얼 번호 */
  serialNumber: string;
  /** 인증서 DN (Distinguished Name) */
  dn: string;
}

export interface SignResult {
  /** 서명된 데이터 (Base64) */
  signedData: string;
  /** 인증서 DN */
  certificateDN: string;
}

/** SEED OID */
const OID_SEED_CBC = '1.2.410.200004.1.4';

/** PBKDF2-SEED OID (PBES2 포함) */
const OID_PBES2 = '1.2.840.113549.1.5.13';
const OID_PBKDF2 = '1.2.840.113549.1.5.12';
const OID_HMAC_SHA1 = '1.2.840.113549.2.7';

export class CertificateManager {
  private certStorePath: string;
  private cachedCerts: CertificateInfo[] = [];

  constructor() {
    this.certStorePath = loadConfig().certStorePath;
  }

  /**
   * NPKI 디렉토리를 재귀 탐색하여 설치된 인증서 목록 반환
   */
  async scanCertificates(): Promise<CertificateInfo[]> {
    const certs: CertificateInfo[] = [];

    if (!fs.existsSync(this.certStorePath)) {
      return certs;
    }

    this.scanDirectory(this.certStorePath, certs);
    this.cachedCerts = certs;
    return certs;
  }

  private scanDirectory(dirPath: string, results: CertificateInfo[]): void {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          this.scanDirectory(fullPath, results);
        } else if (entry.name === 'signCert.der') {
          const keyPath = path.join(dirPath, 'signPri.key');
          if (fs.existsSync(keyPath)) {
            try {
              const certInfo = this.parseCertificate(fullPath, keyPath);
              if (certInfo) {
                results.push(certInfo);
              }
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
   * DER 형식 인증서 파싱
   */
  private parseCertificate(
    certPath: string,
    keyPath: string
  ): CertificateInfo | null {
    const derBuffer = fs.readFileSync(certPath);
    const derBase64 = derBuffer.toString('base64');
    const pem =
      `-----BEGIN CERTIFICATE-----\n` +
      (derBase64.match(/.{1,64}/g)?.join('\n') ?? derBase64) +
      `\n-----END CERTIFICATE-----`;

    const cert = forge.pki.certificateFromPem(pem);

    const subjectCN =
      cert.subject.getField('CN')?.value || '알 수 없는 소유자';
    const issuerCN =
      cert.issuer.getField('CN')?.value || '알 수 없는 발급기관';

    // DN 전체 구성
    const dnParts: string[] = [];
    for (const attr of cert.subject.attributes) {
      if (attr.shortName && attr.value) {
        dnParts.push(`${attr.shortName}=${attr.value}`);
      }
    }
    const dn = dnParts.join(', ');

    return {
      subject: subjectCN,
      issuer: issuerCN,
      validFrom: cert.validity.notBefore.toISOString().split('T')[0],
      validTo: cert.validity.notAfter.toISOString().split('T')[0],
      certPath,
      keyPath,
      serialNumber: cert.serialNumber,
      dn,
    };
  }

  /**
   * 인덱스로 인증서 선택
   */
  getCertificate(index: number): CertificateInfo | null {
    return this.cachedCerts[index] ?? null;
  }

  /**
   * 시리얼 번호로 인증서 찾기
   */
  findBySerial(serialNumber: string): CertificateInfo | null {
    return (
      this.cachedCerts.find((c) => c.serialNumber === serialNumber) ?? null
    );
  }

  /**
   * 데이터에 전자서명 수행
   *
   * 1. 사용자 비밀번호로 개인키 복호화
   * 2. SHA-256 해시 생성
   * 3. RSA-PKCS1v1.5 서명
   */
  async signData(
    certInfo: CertificateInfo,
    challengeData: string,
    password: string
  ): Promise<SignResult> {
    // 개인키 파일 읽기
    const encryptedKeyBuffer = fs.readFileSync(certInfo.keyPath);

    // 개인키 복호화
    const privateKey = await this.decryptPrivateKey(encryptedKeyBuffer, password);

    // challengeData는 Base64로 인코딩된 챌린지 데이터
    const dataBuffer = Buffer.from(challengeData, 'base64');

    // SHA-256 + RSA-PKCS1v1.5 서명
    const md = forge.md.sha256.create();
    md.update(dataBuffer.toString('binary'));
    const signature = privateKey.sign(md);
    const signedData = Buffer.from(signature, 'binary').toString('base64');

    return {
      signedData,
      certificateDN: certInfo.dn || certInfo.subject,
    };
  }

  /**
   * NPKI 개인키 복호화
   *
   * 처리 순서:
   * 1. SEED-CBC-128 (OID: 1.2.410.200004.1.4) - node crypto seed-cbc 사용
   * 2. node-forge 표준 복호화 (AES/3DES PBES2)
   * 3. openssl 명령어 fallback (SEED 지원 확인)
   */
  private async decryptPrivateKey(
    encryptedKey: Buffer,
    password: string
  ): Promise<forge.pki.rsa.PrivateKey> {
    // ASN.1 파싱으로 알고리즘 OID 확인
    const asn1 = forge.asn1.fromDer(encryptedKey.toString('binary'));

    // SEED-CBC 알고리즘 OID 확인
    const algorithmOid = this.extractAlgorithmOid(asn1);

    if (algorithmOid === OID_SEED_CBC) {
      return this.decryptWithSeedCbc(asn1, encryptedKey, password);
    }

    // node-forge 표준 복호화 시도 (PBES2 + AES/3DES)
    // decryptPrivateKeyInfo는 EncryptedPrivateKeyInfo ASN.1을 직접 받음
    try {
      const decryptedAsn1 = forge.pki.decryptPrivateKeyInfo(asn1, password);
      if (decryptedAsn1) {
        return forge.pki.privateKeyFromAsn1(decryptedAsn1) as forge.pki.rsa.PrivateKey;
      }
    } catch {
      // 표준 복호화 실패 시 계속
    }

    // openssl 명령어 fallback
    return this.decryptWithOpenssl(encryptedKey, password);
  }

  /**
   * ASN.1 구조에서 알고리즘 OID 추출
   *
   * EncryptedPrivateKeyInfo 구조:
   *   SEQUENCE {
   *     SEQUENCE {          <- encryptionAlgorithm
   *       OID              <- algorithm OID
   *       ...
   *     }
   *     OCTET STRING       <- encryptedData
   *   }
   */
  private extractAlgorithmOid(asn1: forge.asn1.Asn1): string {
    try {
      const seq = asn1.value as forge.asn1.Asn1[];
      if (!Array.isArray(seq) || seq.length < 2) return '';

      const algSeq = seq[0].value as forge.asn1.Asn1[];
      if (!Array.isArray(algSeq) || algSeq.length < 1) return '';

      const oidAsn1 = algSeq[0];
      if (oidAsn1.type !== forge.asn1.Type.OID) return '';

      return forge.asn1.derToOid(oidAsn1.value as string);
    } catch {
      return '';
    }
  }

  /**
   * SEED-CBC-128 복호화
   *
   * 구조 (PKCS#8 EncryptedPrivateKeyInfo):
   *   SEQUENCE {
   *     SEQUENCE {
   *       OID 1.2.410.200004.1.4  <- SEED-CBC
   *       SEQUENCE {
   *         OCTET STRING (8 bytes)  <- salt
   *         INTEGER                 <- iterations
   *         OCTET STRING (16 bytes) <- IV
   *       }
   *     }
   *     OCTET STRING <- encrypted private key
   *   }
   */
  private decryptWithSeedCbc(
    asn1: forge.asn1.Asn1,
    rawBuffer: Buffer,
    password: string
  ): forge.pki.rsa.PrivateKey {
    const seq = asn1.value as forge.asn1.Asn1[];
    const algSeq = seq[0].value as forge.asn1.Asn1[];

    // 파라미터 추출
    const paramSeq = algSeq[1].value as forge.asn1.Asn1[];

    const saltBinary = paramSeq[0].value as string;
    const salt = Buffer.from(saltBinary, 'binary');

    const iterationsHex = forge.util.bytesToHex(paramSeq[1].value as string);
    const iterations = parseInt(iterationsHex, 16);

    const ivBinary = paramSeq[2].value as string;
    const iv = Buffer.from(ivBinary, 'binary');

    // 암호화된 데이터
    const encDataBinary = seq[1].value as string;
    const encryptedData = Buffer.from(encDataBinary, 'binary');

    // PBKDF1(SHA-1) 키 유도 - SEED-CBC-128은 16바이트 키
    // 한국 NPKI SEED는 PBKDF1 SHA-1 방식 사용
    const key = this.pbkdf1Sha1(Buffer.from(password, 'utf8'), salt, iterations, 16);

    // seed-cbc 복호화 시도
    try {
      const decipher = crypto.createDecipheriv('seed-cbc', key, iv);
      const decrypted = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final(),
      ]);

      // 복호화된 PKCS#8 개인키 파싱
      const decryptedAsn1 = forge.asn1.fromDer(decrypted.toString('binary'));
      return forge.pki.privateKeyFromAsn1(decryptedAsn1) as forge.pki.rsa.PrivateKey;
    } catch (err) {
      throw new Error(
        `SEED-CBC 복호화 실패: 비밀번호가 틀렸거나 OpenSSL이 SEED를 지원하지 않습니다. (${err instanceof Error ? err.message : err})`
      );
    }
  }

  /**
   * PBKDF1 (SHA-1 기반) 키 유도
   * 한국 NPKI SEED 개인키에서 사용하는 방식
   */
  private pbkdf1Sha1(
    password: Buffer,
    salt: Buffer,
    iterations: number,
    keyLength: number
  ): Buffer {
    // D = Hash(password || salt) 반복
    let derived = Buffer.concat([password, salt]);
    for (let i = 0; i < iterations; i++) {
      derived = crypto.createHash('sha1').update(derived).digest();
    }
    return derived.slice(0, keyLength);
  }

  /**
   * openssl 명령어를 통한 복호화 (fallback)
   *
   * openssl pkcs8 -inform DER -in key.der -passin pass:PASSWORD -out decrypted.pem
   */
  private decryptWithOpenssl(
    encryptedKey: Buffer,
    password: string
  ): forge.pki.rsa.PrivateKey {
    const tmpKeyPath = path.join(
      process.env.TEMP || process.env.TMP || '/tmp',
      `npki_key_${Date.now()}.der`
    );

    try {
      fs.writeFileSync(tmpKeyPath, encryptedKey);

      const pemOutput = execFileSync(
        'openssl',
        [
          'pkcs8',
          '-inform', 'DER',
          '-in', tmpKeyPath,
          '-passin', `pass:${password}`,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      ).toString();

      if (!pemOutput.includes('-----BEGIN PRIVATE KEY-----') &&
          !pemOutput.includes('-----BEGIN RSA PRIVATE KEY-----')) {
        throw new Error('openssl 출력이 유효하지 않습니다.');
      }

      const privateKey = forge.pki.privateKeyFromPem(pemOutput);
      return privateKey as forge.pki.rsa.PrivateKey;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('bad decrypt') || msg.includes('wrong password')) {
        throw new Error('인증서 비밀번호가 올바르지 않습니다.');
      }
      throw new Error(
        `개인키 복호화 실패: ${msg}\n` +
        'OpenSSL이 설치되어 있는지 확인하세요 (PATH에 openssl 필요)'
      );
    } finally {
      try {
        fs.unlinkSync(tmpKeyPath);
      } catch {
        // 임시 파일 삭제 실패는 무시
      }
    }
  }

  /**
   * 인증서 유효성 검증
   */
  validateCertificate(certInfo: CertificateInfo): {
    valid: boolean;
    reason?: string;
  } {
    const now = new Date();
    const validTo = new Date(certInfo.validTo);
    const validFrom = new Date(certInfo.validFrom);

    if (now < validFrom) {
      return { valid: false, reason: '인증서가 아직 유효하지 않습니다.' };
    }
    if (now > validTo) {
      return { valid: false, reason: '인증서가 만료되었습니다.' };
    }

    return { valid: true };
  }
}
