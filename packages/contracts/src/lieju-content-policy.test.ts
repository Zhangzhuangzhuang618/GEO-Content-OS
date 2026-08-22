import { describe, expect, it } from 'vitest';

import {
  findLiejuForbiddenContactDetails,
  findLiejuProhibitedPromotionalTerms,
} from './lieju-content-policy.js';

describe('Lieju content policy', () => {
  it('finds every publish-blocked promotional term, including quoted negative examples', () => {
    expect(
      findLiejuProhibitedPromotionalTerms(
        '不要轻信“百分百满意”或“行业第一”等承诺，也不要写自称第一。',
      ),
    ).toEqual(['百分百', '行业第一', '自称第一']);
  });

  it('does not treat ordinary sequence or first-party evidence wording as a ranking claim', () => {
    expect(
      findLiejuProhibitedPromotionalTerms(
        '第一步核对清单，第一阶段确认报价，企业第一方资料需要单独标注。',
      ),
    ).toEqual([]);
  });

  it('allows URLs while still finding phones and external accounts', () => {
    expect(
      findLiejuForbiddenContactDetails(
        '可访问 https://example.test/path、www.gsxt.gov.cn 或 ysfw.mot.gov.cn，联系电话 02085627757，微信 zybj2026，联系 GZzy123456。',
      ),
    ).toEqual([
      { kind: 'phone', value: '电话 02085627757' },
      { kind: 'external_account', value: '微信 zybj2026' },
      { kind: 'external_account', value: '联系 GZzy123456' },
    ]);
  });

  it('does not treat authority or qualification wording as a platform lexical ban', () => {
    expect(
      findLiejuProhibitedPromotionalTerms(
        '企业资质可通过权威机构公开渠道核验，国家级资质声明必须有对应证据。',
      ),
    ).toEqual([]);
  });

  it('allows neutral verification-channel and page-contact guidance', () => {
    expect(
      findLiejuForbiddenContactDetails(
        '营业执照可在国家企业信用信息公示系统核验，道路运输许可可通过交通运输主管部门官方查询渠道核验，也可通过页面联系方式说明需求。',
      ),
    ).toEqual([]);
  });
});
