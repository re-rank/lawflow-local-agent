/**
 * ecfs-crypto.js
 * ECFS 전자소송 포털 인증서 로그인을 위한 암호화 유틸리티
 *
 * AnySign4PC 프로그램의 역할을 Node.js에서 대체합니다.
 * - CMS (PKCS#7) SignedData 생성 (signVal)
 * - VID (Virtual Identity Data) 봉투 생성 (encVid)
 *
 * NPKI 개인키가 SEED-CBC로 암호화되어 있으므로 (Electron/BoringSSL 미지원),
 * 순수 JavaScript SEED 구현으로 직접 복호화합니다.
 */

const fs = require("fs");
const crypto = require("crypto");
const forge = require("node-forge");
const state = require("./state");
const { addLog } = require("./utils");
const { seedDecryptCBC } = require("./seed-cipher");

// ---------------------------------------------------------------------------
// OID 상수
// ---------------------------------------------------------------------------

const OID_PBES2              = "1.2.840.113549.1.5.13";
const OID_PBKDF2             = "1.2.840.113549.1.5.12";
const OID_SEED_CBC           = "1.2.410.200004.1.4";
const OID_SEED_CBC_WITH_SHA1 = "1.2.410.200004.1.15";
const OID_HMAC_SHA1          = "1.2.840.113549.2.7";

// ---------------------------------------------------------------------------
// ASN.1 파싱 헬퍼
// ---------------------------------------------------------------------------

/**
 * forge ASN.1 OID 값 문자열을 반환합니다.
 */
function oidValue(asn1Node) {
  return forge.asn1.derToOid(asn1Node.value);
}

/**
 * forge ASN.1 INTEGER 노드를 JS number로 반환합니다.
 */
function asn1Integer(asn1Node) {
  // forge는 INTEGER를 DER 인코딩 문자열로 저장
  let val = 0;
  for (let i = 0; i < asn1Node.value.length; i++) {
    val = (val * 256 + asn1Node.value.charCodeAt(i)) >>> 0;
  }
  return val;
}

/**
 * forge ASN.1 OCTET STRING 값을 Buffer로 반환합니다.
 */
function asn1OctetBuffer(asn1Node) {
  return Buffer.from(asn1Node.value, "binary");
}

// ---------------------------------------------------------------------------
// NPKI 개인키 복호화 메인 함수
// ---------------------------------------------------------------------------

/**
 * NPKI 암호화된 개인키 파일(DER)을 복호화하여 forge RSA 개인키 객체를 반환합니다.
 *
 * 지원 알고리즘:
 *   - PBES2 (OID 1.2.840.113549.1.5.13) + PBKDF2 + SEED-CBC
 *   - seedCBCWithSHA1 (OID 1.2.410.200004.1.15) + PBKDF1-SHA1
 *
 * EncryptedPrivateKeyInfo ASN.1 구조:
 *   SEQUENCE {
 *     SEQUENCE { OID, ANY }   -- AlgorithmIdentifier
 *     OCTET STRING            -- encryptedData
 *   }
 *
 * @param {string} keyPath  - signPri.key 파일 경로
 * @param {string} password - 인증서 비밀번호
 * @returns {forge.pki.rsa.PrivateKey}
 */
function decryptNpkiPrivateKey(keyPath, password) {
  const keyDer = fs.readFileSync(keyPath);
  const keyBinary = keyDer.toString("binary");
  const asn1 = forge.asn1.fromDer(keyBinary, { strict: false, parseAllBytes: false });

  // 최상위: SEQUENCE { AlgorithmIdentifier, OCTET STRING }
  if (asn1.type !== forge.asn1.Type.SEQUENCE || asn1.value.length < 2) {
    throw new Error("EncryptedPrivateKeyInfo 구조가 올바르지 않습니다.");
  }

  const algId       = asn1.value[0]; // SEQUENCE { OID, params }
  const encDataNode = asn1.value[1]; // OCTET STRING

  const oid    = oidValue(algId.value[0]);
  const params = algId.value[1];
  const encData = asn1OctetBuffer(encDataNode);

  let plaintext;

  if (oid === OID_PBES2) {
    plaintext = _decryptPbes2(params, password, encData);
  } else if (oid === OID_SEED_CBC_WITH_SHA1) {
    plaintext = _decryptSeedCbcWithSha1(params, password, encData);
  } else {
    throw new Error(`지원하지 않는 암호화 OID: ${oid}`);
  }

  // 복호화된 데이터는 PKCS#8 PrivateKeyInfo DER
  return _parsePkcs8PrivateKey(plaintext);
}

// ---------------------------------------------------------------------------
// PBES2 복호화
// ---------------------------------------------------------------------------

/**
 * PBES2 (PBKDF2 + SEED-CBC) 복호화
 *
 * PBES2 params ASN.1:
 *   SEQUENCE {
 *     SEQUENCE { OID(PBKDF2), SEQUENCE { salt, iter, [keyLen], [PRF] } }
 *     SEQUENCE { OID(SEED-CBC), IV(OCTET STRING) }
 *   }
 */
function _decryptPbes2(params, password, encData) {
  // params.value[0] = keyDerivationFunc SEQUENCE
  // params.value[1] = encryptionScheme SEQUENCE
  const kdfSeq = params.value[0];
  const encSchemeSeq = params.value[1];

  const kdfOid = oidValue(kdfSeq.value[0]);
  if (kdfOid !== OID_PBKDF2) {
    throw new Error(`지원하지 않는 KDF OID: ${kdfOid}`);
  }

  const encSchemeOid = oidValue(encSchemeSeq.value[0]);
  if (encSchemeOid !== OID_SEED_CBC) {
    throw new Error(`지원하지 않는 암호화 스킴 OID: ${encSchemeOid}`);
  }

  // PBKDF2 파라미터 파싱
  // SEQUENCE { salt(OCTET STRING), iter(INTEGER), [keyLen(INTEGER)], [PRF(SEQUENCE)] }
  const pbkdf2Params = kdfSeq.value[1];
  const salt       = asn1OctetBuffer(pbkdf2Params.value[0]);
  const iterations = asn1Integer(pbkdf2Params.value[1]);

  // keyLen은 선택적 (기본 16 = 128비트)
  let keyLen = 16;
  if (pbkdf2Params.value.length > 2 &&
      pbkdf2Params.value[2].type === forge.asn1.Type.INTEGER) {
    keyLen = asn1Integer(pbkdf2Params.value[2]);
  }

  // SEED-CBC IV
  const iv = asn1OctetBuffer(encSchemeSeq.value[1]);

  // PBKDF2 키 유도
  const pwBuf = Buffer.from(password, "utf8");
  const key   = crypto.pbkdf2Sync(pwBuf, salt, iterations, keyLen, "sha1");

  return seedDecryptCBC(key, iv, encData);
}

// ---------------------------------------------------------------------------
// seedCBCWithSHA1 (PBKDF1-SHA1) 복호화
// ---------------------------------------------------------------------------

/**
 * seedCBCWithSHA1 (OID 1.2.410.200004.1.15) 복호화
 *
 * PBKDF1-SHA1:
 *   hash = SHA1(password_bytes || salt)
 *   for i in 1..iterations-1: hash = SHA1(hash)
 *   DK = hash[0:16]  (키)
 *   IV = SHA1(DK)[0:16]
 *
 * params ASN.1:
 *   SEQUENCE { OCTET STRING(salt), INTEGER(iterations) }
 */
function _decryptSeedCbcWithSha1(params, password, encData) {
  const salt       = asn1OctetBuffer(params.value[0]);
  const iterations = asn1Integer(params.value[1]);

  const pwBuf = Buffer.from(password, "utf8");

  // PBKDF1: hash = SHA1(password || salt), 반복
  let hash = crypto.createHash("sha1")
    .update(pwBuf)
    .update(salt)
    .digest();

  for (let i = 1; i < iterations; i++) {
    hash = crypto.createHash("sha1").update(hash).digest();
  }

  const key = hash.slice(0, 16);
  const iv  = crypto.createHash("sha1").update(hash).digest().slice(0, 16);

  return seedDecryptCBC(key, iv, encData);
}

// ---------------------------------------------------------------------------
// PKCS#8 PrivateKeyInfo 파싱
// ---------------------------------------------------------------------------

/**
 * PKCS#8 PrivateKeyInfo DER(Buffer)를 forge RSA 개인키로 변환합니다.
 *
 * PrivateKeyInfo ASN.1:
 *   SEQUENCE {
 *     INTEGER (version=0)
 *     SEQUENCE { OID(rsaEncryption), NULL }
 *     OCTET STRING (RSAPrivateKey DER)
 *   }
 */
function _parsePkcs8PrivateKey(derBuf) {
  const binary = derBuf.toString("binary");
  const asn1   = forge.asn1.fromDer(binary, { strict: false, parseAllBytes: false });

  // forge.pki.privateKeyFromAsn1 는 PKCS#8 PrivateKeyInfo를 직접 처리합니다
  try {
    return forge.pki.privateKeyFromAsn1(asn1);
  } catch {
    // 일부 KISA PKCS#8 구조는 수동 파싱 필요
    // PrivateKeyInfo.value[2] = OCTET STRING containing RSAPrivateKey
    const rsaKeyDer = asn1.value[2].value;
    const rsaAsn1   = forge.asn1.fromDer(rsaKeyDer, { strict: false, parseAllBytes: false });
    return forge.pki.privateKeyFromAsn1(rsaAsn1);
  }
}

// ---------------------------------------------------------------------------
// CMS SignedData 생성
// ---------------------------------------------------------------------------

/**
 * CMS (PKCS#7) SignedData를 생성합니다.
 *
 * ECFS 서버는 AnySign4PC의 signDataCMS 명령이 반환하는
 * PKCS#7 SignedData(DER, Base64)를 기대합니다.
 *
 * @param {string} plainText - 서명할 원문 (예: "SCMAIN")
 * @returns {string} Base64 인코딩된 CMS SignedData DER
 */
function createCmsSignedData(plainText) {
  // 1. 인증서 읽기 (DER → forge certificate)
  const certDerBuf = fs.readFileSync(state.certPath);
  const certAsn1   = forge.asn1.fromDer(
    forge.util.createBuffer(certDerBuf.toString("binary")),
    { strict: false, parseAllBytes: false }
  );
  const cert = forge.pki.certificateFromAsn1(certAsn1);

  // 2. 개인키 복호화 (SEED-CBC 순수 JS 구현 사용)
  const privateKey = decryptNpkiPrivateKey(state.certKeyPath, state.certPassword);

  // 3. PKCS#7 SignedData 구성
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(plainText, "utf8");
  p7.addCertificate(cert);
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      {
        type: forge.pki.oids.contentType,
        value: forge.pki.oids.data,
      },
      {
        type: forge.pki.oids.messageDigest,
        // forge가 자동 계산
      },
      {
        type: forge.pki.oids.signingTime,
        value: new Date(),
      },
    ],
  });
  p7.sign();

  // 4. DER → Base64
  const derBytes = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(derBytes);
}

// ---------------------------------------------------------------------------
// VID 봉투 생성
// ---------------------------------------------------------------------------

/**
 * VID (Virtual Identity Data) 봉투를 생성합니다.
 *
 * ECFS는 XW_FVIEW_CREATE_VID_NO_IDN 옵션을 사용합니다.
 * IDN으로 "123"(더미값)을 사용하며, 랜덤 값과 함께 해시하여
 * 서버 인증서의 공개키로 암호화합니다.
 *
 * VIDData ASN.1 구조:
 *   SEQUENCE {
 *     INTEGER 0  (version)
 *     OCTET STRING  (vid = SHA-256(idn || random))
 *     OCTET STRING  (randomNum)
 *   }
 *
 * @param {string} svrCertData - 서버 인증서 (Base64 DER 또는 PEM)
 * @returns {string} Base64 인코딩된 암호화 VID 데이터
 */
function createVidEnvelope(svrCertData) {
  // 서버 인증서 파싱 (PEM / Base64 DER 모두 지원)
  let svrCert;
  const cleaned = String(svrCertData).trim();
  if (cleaned.includes("-----BEGIN")) {
    svrCert = forge.pki.certificateFromPem(cleaned);
  } else {
    const svrDer  = forge.util.decode64(cleaned);
    const svrAsn1 = forge.asn1.fromDer(svrDer, { strict: false, parseAllBytes: false });
    svrCert = forge.pki.certificateFromAsn1(svrAsn1);
  }

  // IDN 값 ("123" - ECFS Sign_without_vid_web에서 전달하는 값)
  const idn = "123";

  // 랜덤 값 생성 (20바이트)
  const randomNum = forge.random.getBytesSync(20);

  // VID = SHA-256(IDN || randomNum)
  const md = forge.md.sha256.create();
  md.update(idn, "utf8");
  md.update(randomNum);
  const vid = md.digest().getBytes();

  // VIDData ASN.1 구조 생성
  const vidData = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    [
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.INTEGER,
        false,
        forge.asn1.integerToDer(0).getBytes()
      ),
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OCTETSTRING,
        false,
        vid
      ),
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OCTETSTRING,
        false,
        randomNum
      ),
    ]
  );

  // DER 직렬화 → 서버 공개키로 RSA 암호화
  const vidDer    = forge.asn1.toDer(vidData).getBytes();
  const encrypted = svrCert.publicKey.encrypt(vidDer, "RSAES-PKCS1-V1_5");

  return forge.util.encode64(encrypted);
}

// ---------------------------------------------------------------------------
// 통합 함수
// ---------------------------------------------------------------------------

/**
 * CMS 서명 + VID 봉투 생성을 한 번에 수행합니다.
 *
 * @param {string} plainText   - 서명할 원문 ("SCMAIN")
 * @param {string} svrCertData - 서버 인증서
 * @returns {{ signVal: string, encVid: string }}
 */
function createSignAndVid(plainText, svrCertData) {
  const signVal = createCmsSignedData(plainText);
  const encVid  = createVidEnvelope(svrCertData);
  return { signVal, encVid };
}

module.exports = {
  decryptNpkiPrivateKey,
  createCmsSignedData,
  createVidEnvelope,
  createSignAndVid,
};
