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
// forge.asn1.fromDer 패치: 한국 NPKI 인증서 trailing bytes 대응
//
// 한국 NPKI 인증서 파일(signCert.der, signPri.key)에는 ASN.1 구조 뒤에
// 여분의 바이트가 있을 수 있습니다. forge 내부 함수(certificateFromAsn1,
// privateKeyFromAsn1 등)가 fromDer를 호출할 때 기본값 parseAllBytes=true로
// 인해 "Unparsed DER bytes remain" 에러가 발생합니다.
// 모든 fromDer 호출에서 기본값을 parseAllBytes=false로 변경합니다.
// ---------------------------------------------------------------------------
const _origFromDer = forge.asn1.fromDer;
forge.asn1.fromDer = function (bytes, options) {
  const opts = Object.assign(
    { strict: false, parseAllBytes: false },
    options || {}
  );
  return _origFromDer.call(forge.asn1, bytes, opts);
};

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
  addLog(`개인키 경로: ${keyPath}`, "info");
  addLog(`비밀번호 길이: ${password ? password.length : "null"}자`, "info");

  // Step 1: 파일 읽기
  let keyDer;
  try {
    keyDer = fs.readFileSync(keyPath);
    addLog(`개인키 파일 크기: ${keyDer.length}바이트`, "info");
  } catch (e) {
    throw new Error(`개인키 파일 읽기 실패 (${keyPath}): ${e.message}`);
  }

  // Step 2: ASN.1 파싱
  let asn1;
  try {
    const keyBinary = keyDer.toString("binary");
    asn1 = forge.asn1.fromDer(keyBinary, { strict: false, parseAllBytes: false });
  } catch (e) {
    throw new Error(`개인키 DER 파싱 실패: ${e.message}`);
  }

  // 최상위: SEQUENCE { AlgorithmIdentifier, OCTET STRING }
  if (!asn1 || asn1.type !== forge.asn1.Type.SEQUENCE || !Array.isArray(asn1.value) || asn1.value.length < 2) {
    throw new Error("EncryptedPrivateKeyInfo 구조가 올바르지 않습니다.");
  }

  const algId       = asn1.value[0]; // SEQUENCE { OID, params }
  const encDataNode = asn1.value[1]; // OCTET STRING

  if (!algId || !algId.value || algId.value.length < 2) {
    throw new Error("AlgorithmIdentifier 구조가 올바르지 않습니다.");
  }

  // Step 3: 암호화 알고리즘 식별
  const oid    = oidValue(algId.value[0]);
  const params = algId.value[1];
  const encData = asn1OctetBuffer(encDataNode);

  addLog(`개인키 암호화 알고리즘: ${oid}`, "info");

  // Step 4: 복호화
  let plaintext;
  try {
    if (oid === OID_PBES2) {
      plaintext = _decryptPbes2(params, password, encData);
    } else if (oid === OID_SEED_CBC_WITH_SHA1) {
      plaintext = _decryptSeedCbcWithSha1(params, password, encData);
    } else {
      throw new Error(`지원하지 않는 암호화 OID: ${oid}`);
    }
  } catch (e) {
    throw new Error(`키 복호화 실패 (${oid}): ${e.message}`);
  }

  // Step 5: PKCS#8 개인키 파싱
  try {
    return _parsePkcs8PrivateKey(plaintext);
  } catch (e) {
    throw new Error(`PKCS#8 개인키 파싱 실패: ${e.message}`);
  }
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
 *   T₁ = SHA1(password || salt)
 *   for i in 2..count: Tᵢ = SHA1(Tᵢ₋₁)
 *   DK = Tₙ (20바이트)
 *
 * 키/IV 유도 (PyPinkSign, twkang/gist 등 레퍼런스 구현 기준):
 *   Key = DK[0:16]              (16바이트 SEED 키)
 *   IV  = SHA1(DK[16:20])[0:16] (마지막 4바이트의 SHA1 해시)
 *
 * params ASN.1:
 *   SEQUENCE { OCTET STRING(salt), INTEGER(iterations) }
 */
function _decryptSeedCbcWithSha1(params, password, encData) {
  const salt       = asn1OctetBuffer(params.value[0]);
  const iterations = asn1Integer(params.value[1]);

  if (!password || password.length === 0) {
    throw new Error("비밀번호가 비어있습니다.");
  }

  const pwBuf = Buffer.from(password, "utf8");

  addLog(`seedCBC: salt=${salt.toString("hex")}, iter=${iterations}, pwLen=${pwBuf.length}`, "info");

  // PBKDF1: T₁ = SHA1(password || salt), 반복 count회
  let hash = crypto.createHash("sha1")
    .update(pwBuf)
    .update(salt)
    .digest();

  for (let i = 1; i < iterations; i++) {
    hash = crypto.createHash("sha1").update(hash).digest();
  }

  // hash = Tₙ (20바이트)
  const key = hash.slice(0, 16);
  // IV = SHA1(Tₙ[16:20])[0:16] — 마지막 4바이트를 SHA1 해싱
  const tailBytes = hash.slice(16, 20);
  const iv = crypto.createHash("sha1").update(tailBytes).digest().slice(0, 16);

  addLog(`seedCBC: key=${key.toString("hex")}, iv=${iv.toString("hex")}`, "info");

  try {
    const plaintext = seedDecryptCBC(key, iv, encData);
    if (plaintext.length > 0 && plaintext[0] === 0x30) {
      addLog(`seedCBC 복호화 성공 (${plaintext.length}바이트)`, "success");
      return plaintext;
    }
    addLog(`seedCBC 첫 바이트: 0x${plaintext[0].toString(16)} (기대: 0x30)`, "warning");
  } catch (e) {
    addLog(`seedCBC 복호화 실패: ${e.message}`, "warning");
  }

  // 실패 시 대체 IV 방법 시도 (구버전 호환)
  const altIvCandidates = [
    { name: "SHA1(Key)[0:16]", iv: crypto.createHash("sha1").update(key).digest().slice(0, 16) },
    { name: "SHA1(Tn)[0:16]",  iv: crypto.createHash("sha1").update(hash).digest().slice(0, 16) },
  ];

  for (const { name, iv: altIv } of altIvCandidates) {
    try {
      const plaintext = seedDecryptCBC(key, altIv, encData);
      if (plaintext.length > 0 && plaintext[0] === 0x30) {
        addLog(`대체 IV 유도: ${name} (성공)`, "info");
        return plaintext;
      }
    } catch {
      // 다음 후보 시도
    }
  }

  throw new Error(
    "모든 IV 유도 방법 실패. 비밀번호가 올바른지 확인하세요."
  );
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
  if (!derBuf || derBuf.length === 0) {
    throw new Error("복호화된 개인키 데이터가 비어있습니다 (비밀번호가 올바른지 확인하세요).");
  }

  addLog(`복호화된 키 데이터: ${derBuf.length}바이트, 시작=${derBuf.slice(0, 8).toString("hex")}`, "info");

  // 복호화된 데이터가 유효한 ASN.1 SEQUENCE인지 확인
  if (derBuf[0] !== 0x30) {
    throw new Error(
      `복호화 결과가 유효하지 않습니다 (첫 바이트: 0x${derBuf[0].toString(16)}, 기대: 0x30). ` +
      `비밀번호가 올바른지 확인하세요.`
    );
  }

  const binary = derBuf.toString("binary");
  const asn1   = forge.asn1.fromDer(binary, { strict: false, parseAllBytes: false });

  // 방법 1: forge.pki.privateKeyFromAsn1로 PKCS#8 직접 처리
  try {
    return forge.pki.privateKeyFromAsn1(asn1);
  } catch (e1) {
    addLog(`PKCS#8 직접 파싱 실패: ${e1.message}, 수동 파싱 시도...`, "info");

    // 방법 2: PKCS#8 PrivateKeyInfo에서 RSAPrivateKey OCTET STRING 직접 추출
    if (!asn1.value || !Array.isArray(asn1.value) || asn1.value.length < 3) {
      throw new Error(
        `PKCS#8 구조 불일치 (필드 ${asn1.value ? asn1.value.length : 0}개). ` +
        `복호화 결과가 올바르지 않습니다 (비밀번호 확인 필요): ${e1.message}`
      );
    }

    const octetNode = asn1.value[2];
    if (!octetNode || !octetNode.value) {
      throw new Error(`PKCS#8 개인키 OCTET STRING이 없습니다: ${e1.message}`);
    }

    try {
      const rsaKeyDer = octetNode.value;
      const rsaAsn1   = forge.asn1.fromDer(rsaKeyDer, { strict: false, parseAllBytes: false });
      return forge.pki.privateKeyFromAsn1(rsaAsn1);
    } catch (e2) {
      throw new Error(`RSA 개인키 파싱 실패: ${e2.message} (원인: ${e1.message})`);
    }
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
  // Step 1: 인증서 읽기 (DER → forge certificate)
  let cert;
  try {
    const certDerBuf = fs.readFileSync(state.certPath);
    const certAsn1   = forge.asn1.fromDer(
      forge.util.createBuffer(certDerBuf.toString("binary")),
      { strict: false, parseAllBytes: false }
    );
    cert = forge.pki.certificateFromAsn1(certAsn1);
  } catch (e) {
    throw new Error(`[1단계] 인증서 읽기 실패 (${state.certPath}): ${e.message}`);
  }

  // Step 2: 개인키 복호화 (SEED-CBC 순수 JS 구현 사용)
  let privateKey;
  try {
    privateKey = decryptNpkiPrivateKey(state.certKeyPath, state.certPassword);
  } catch (e) {
    throw new Error(`[2단계] 개인키 복호화 실패: ${e.message}`);
  }

  // Step 3: PKCS#7 SignedData 구성 및 서명
  try {
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

    // DER → Base64
    const derBytes = forge.asn1.toDer(p7.toAsn1()).getBytes();
    return forge.util.encode64(derBytes);
  } catch (e) {
    throw new Error(`[3단계] CMS 서명 실패: ${e.message}`);
  }
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
