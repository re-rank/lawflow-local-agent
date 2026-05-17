/**
 * ecfs-form-fields.js
 * ECFS WebSquare 컴포넌트 ID 매핑 (ecfs-fields.ts의 JS 포트)
 */

/** 소장 폼 필드 */
const WS_COMPLAINT_FIELDS = {
  caseBasic: {
    caseNameDiv: "sbx_csNmDvs",
    caseName: "ibx_saNm",
    court: "sbx_cortList",
    claimDiv_property: "rad_clmDvs_input_0",
    claimDiv_non: "rad_clmDvs_input_1",
    amtType_amount: "rad_vsmlDvs_input_0",
    amtType_land: "rad_vsmlDvs_input_1",
    amtType_uncalc: "rad_vsmlDvs_input_2",
    claimAmount: "ibx_vsmlAmt",
  },
  party: {
    typePlaintiff: "rad_btprtDvsCd_input_0",
    typeDefendant: "rad_btprtDvsCd_input_1",
    personType: "sbx_btprtPrsnlDvsCd",
    nonMember: "cbx_nmbrs_input_0",
    idFront: "ibx_btprtEnrrno",
    idBack: "ibx_btprtEnrrno2",
    bizNo1: "ibx_bzno",
    bizNo2: "ibx_bzno2",
    bizNo3: "ibx_bzno3",
    name: "ibx_btprtNm",
    reprTitle: "sbx_rprsStndngNm",
    reprName: "ibx_orgnzRprsNm",
    zipCode: "ibx_btprtZpcd",
    baseAddr: "ibx_btprtBasAddr",
    detailAddr: "ibx_btprtDtlAddr",
    sameAddr: "cbx_sameAddr_input_0",
    deliveryZip: "ibx_btprtDlvrZpcd",
    deliveryBase: "ibx_btprtDlvrBasAddr",
    deliveryDetail: "ibx_btprtDlvrDtlAddr",
    mobilePrefix: "sbx_mblTelno",
    mobile2: "ibx_mblTelno2",
    mobile3: "ibx_mblTelno3",
    emailId: "ibx_emlAddr",
    emailDomain: "ibx_emlAddr2",
    emailDomainSel: "sbx_emlAddr",
  },
  claimPurpose: { content: "txa_prpclCtt" },
  claimReason: { directInput: "rad_input_input_0", fileInput: "rad_file_input_0" },
  buttons: { tmpSave: "btn_tmpSave", complete: "btn_wrtCmptn" },
};

/** 지급명령 필드 */
const WS_PAYMENT_ORDER_FIELDS = {
  caseBasic: {
    caseNameDiv: "sbx_csNmDvs",
    caseName: "ibx_csNm",
    court: "sbx_cortList",
    claimAmount: "ibx_vsmlAmt",
    requestAmount: "ibx_clmAmt",
  },
  party: WS_COMPLAINT_FIELDS.party,
  claimPurpose: { content: "txa_prpclCtt" },
  claimReason: { directInput: "rad_input_input_0", fileInput: "rad_file_input_0" },
  buttons: { tmpSave: "btn_tmpSave", complete: "btn_wrtCmptn" },
};

/** 가사 소장 필드 */
const WS_FAMILY_COMPLAINT_FIELDS = {
  caseBasic: {
    caseNameDiv: "sbx_csNmDvs",
    caseNameClass: "sbx_csNmCl",
    caseName: "ibx_csNm",
    court: "sbx_cortList",
    claimDiv_property: "rad_clmDvs_input_0",
    claimDiv_non: "rad_clmDvs_input_1",
    amtType_amount: "rad_vsmlDvs_input_0",
    amtType_land: "rad_vsmlDvs_input_1",
    amtType_uncalc: "rad_vsmlDvs_input_2",
    claimAmount: "ibx_vsmlAmt",
    propertyDivisionAmt: "ibx_prprtPrtlAmt",
  },
  party: WS_COMPLAINT_FIELDS.party,
  claimPurpose: { content: "txa_ctt1" },
  claimReason: { directInput: "rad_aplyResnDr_input_0", fileInput: "rad_aplyResnFl_input_0" },
  buttons: { tmpSave: "btnTmpSave", complete: "btn_wrtCmptn" },
};

/** 서류 라우팅 매핑 (주요 서류만) */
const DOC_ROUTING = {
  complaint: { menuParam: "PSPA13M01", directUrl: "PSPB01M01", flow: "A" },
  answer: { menuParam: "PSPA13M01", routing: { p1: "01", p2: "01", category: "11", docIndex: "1" }, flow: "B" },
  brief: { menuParam: "PSPA13M01", routing: { p1: "01", p2: "01", category: "11", docIndex: "2" }, flow: "B" },
  evidence: { menuParam: "PSPA13M01", routing: { p1: "01", p2: "01", category: "13", docIndex: "1" }, flow: "B" },
  appeal: { menuParam: "PSPA13M01", routing: { p1: "01", p2: "01", category: "20", docIndex: "1" }, flow: "B" },
  payment_order: { menuParam: "PSPA13M03", routing: { p1: "01", p2: "04", category: "40", docIndex: "1" }, flow: "A" },
  family_divorce: { menuParam: "PSPA14M01", routing: { p1: "02", p2: "05", category: "82", docIndex: "4" }, flow: "A" },
};

/**
 * docType에 맞는 필드 매핑 반환
 */
function getFieldsMap(docType) {
  if (docType === "payment_order") return WS_PAYMENT_ORDER_FIELDS;
  if (docType.startsWith("family_")) return WS_FAMILY_COMPLAINT_FIELDS;
  return WS_COMPLAINT_FIELDS;
}

module.exports = { DOC_ROUTING, getFieldsMap, WS_COMPLAINT_FIELDS, WS_PAYMENT_ORDER_FIELDS, WS_FAMILY_COMPLAINT_FIELDS };
