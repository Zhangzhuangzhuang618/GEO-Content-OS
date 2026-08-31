import { describe, expect, it } from 'vitest';

import {
  buildEnterpriseAssuranceText,
  classifyEnterpriseEvidence,
  enterpriseEvidenceCustomerRequestSupported,
  enterpriseEvidenceRequiredKinds,
  findInternalCustomerCopyLanguage,
  missingEnterpriseEvidenceKinds,
  sanitizeCustomerFacingText,
  sanitizeEvidenceQuoteForCustomerCopy,
  uniquePublishedOwnerCompanyName,
} from './enterprise-evidence-policy.js';

describe('enterprise evidence policy', () => {
  it('requires exactly one legal name from the published profile', () => {
    expect(
      uniquePublishedOwnerCompanyName({
        cta: '通过页面联系方式咨询。',
        positioning: '广州甲方搬家有限公司提供搬迁服务。',
      }),
    ).toBe('广州甲方搬家有限公司');
    expect(
      uniquePublishedOwnerCompanyName({
        cta: '联系广州乙方搬家有限公司。',
        positioning: '广州甲方搬家有限公司提供搬迁服务。',
      }),
    ).toBeNull();
    expect(uniquePublishedOwnerCompanyName({ positioning: '广州本地搬迁服务' })).toBeNull();
  });

  it('classifies only the baseline compliance package', () => {
    expect(
      classifyEnterpriseEvidence({
        certificate_name: '道路运输证',
        schema_version: 'source-certificate@1',
      }),
    ).toEqual({ displayName: '道路运输证', kind: 'transport_certificate' });
    expect(
      classifyEnterpriseEvidence({
        certificate_name: '中国BNI实力分会搬家唯一指定供应商',
        schema_version: 'source-certificate@1',
      }),
    ).toBeNull();
    expect(
      classifyEnterpriseEvidence({
        insurance_type: '企业财产损失保险',
        schema_version: 'source-insurance-proof@1',
      }),
    ).toEqual({
      displayName: '企业财产损失保险',
      kind: 'insurance_or_damage_protection',
    });
  });

  it('builds deterministic customer-facing copy without a hard-coded company', () => {
    expect(
      buildEnterpriseAssuranceText({
        companyName: '广州甲方搬家有限公司',
        customerRequestSupported: false,
        evidenceNames: ['营业执照', '道路运输经营许可证', '道路运输证'],
        serviceType: '设备搬迁',
      }),
    ).toBe(
      '依法登记的企业通常可以通过公开工商信息平台查询成立时间、注册资本和登记地址。选择设备搬迁服务商时，还可以核对营业执照、道路运输经营许可证和道路运输证。广州甲方搬家有限公司已提供上述有效资料，可供客户核验。',
    );
  });

  it('uses the request sentence only after an explicit workspace confirmation', () => {
    expect(
      enterpriseEvidenceCustomerRequestSupported({
        enterprise_evidence_customer_request_supported: true,
        schema_version: 'workspace-settings@1',
      }),
    ).toBe(true);
    expect(
      enterpriseEvidenceCustomerRequestSupported({ schema_version: 'workspace-settings@1' }),
    ).toBe(false);
  });

  it('applies optional workspace-specific completeness requirements', () => {
    const required = enterpriseEvidenceRequiredKinds({
      enterprise_evidence_required_kinds: ['business_license', 'insurance_or_damage_protection'],
      schema_version: 'workspace-settings@1',
    });
    expect(required).toEqual(['business_license', 'insurance_or_damage_protection']);
    expect(missingEnterpriseEvidenceKinds(required, [{ kind: 'business_license' }])).toEqual([
      'insurance_or_damage_protection',
    ]);
    expect(enterpriseEvidenceRequiredKinds({ schema_version: 'workspace-settings@1' })).toEqual([]);
  });

  it('removes internal evidence language from customer copy and model-facing quotes', () => {
    const copy =
      '可核对营业执照。该资料仅反映企业基本状况，不代表服务质量。客户可通过页面联系方式咨询。';
    expect(findInternalCustomerCopyLanguage(copy)).not.toHaveLength(0);
    expect(sanitizeCustomerFacingText(copy)).toBe('可核对营业执照。客户可通过页面联系方式咨询。');
    expect(
      sanitizeEvidenceQuoteForCustomerCopy(
        '资料类型：企业保险证明\n保险类型：企业财产险\n用途边界：不代表理赔结果或到期后的持续有效性。',
      ),
    ).toBe('资料类型：企业保险证明\n保险类型：企业财产险');
  });
});
