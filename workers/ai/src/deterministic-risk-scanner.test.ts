import type { QualityCheckerData } from '@geo-content-os/contracts/skills';
import { describe, expect, it } from 'vitest';

import {
  mergeDeterministicRiskIssues,
  scanDeterministicRisks,
} from './deterministic-risk-scanner.js';

describe('deterministic pre-publish risk scanner', () => {
  it('accepts approved first-party scale facts and complete official-site GEO metadata', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand({
        differentiators: ['自有大型车辆30+台，自有搬家师傅数十人，均为正式员工。'],
      }),
      citations: [],
      content: content({
        blocks: [block('intro', '志远搬家自有大型车辆30余台，自有搬家师傅数十人。')],
      }),
      platformCode: 'official_site',
    });

    expect(issues).toEqual([]);
  });

  it('blocks official-site content when the workspace service phone is not configured', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand({ contact: {} }),
      citations: [],
      content: content({ cta: null }),
      platformCode: 'official_site',
    });

    expect(issues.map((item) => item.rule_id)).toContain(
      'deterministic.official_site.service_phone_profile_required',
    );
  });

  it('requires the configured service phone exactly once in the official-site CTA', () => {
    const missing = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({ cta: '欢迎咨询。' }),
      platformCode: 'official_site',
    });
    const repeated = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({
        blocks: [block('intro', '本文说明广州企业搬家前的准备方法，电话02085627757。')],
      }),
      platformCode: 'official_site',
    });
    const wrongExtraPhone = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({ cta: '请致电 02085627757 或 4007654321。' }),
      platformCode: 'official_site',
    });

    expect(missing.map((item) => item.rule_id)).toContain(
      'deterministic.official_site.service_phone_required',
    );
    expect(repeated.map((item) => item.rule_id)).toContain(
      'deterministic.official_site.service_phone_required',
    );
    expect(wrongExtraPhone.map((item) => item.rule_id)).toContain(
      'deterministic.official_site.service_phone_required',
    );
  });

  it('checks each sensitive claim instead of requiring every number in the surrounding block', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand({
        differentiators: ['自有大型车辆30+台，自有搬家师傅数十人，均为正式员工。'],
      }),
      citations: [],
      content: content({
        blocks: [
          block(
            'intro',
            '志远搬家自有大型车辆30余台，自有搬家师傅数十人。建议客户提前3天整理物品，并按2个区域制作清单。',
          ),
        ],
      }),
      platformCode: 'official_site',
    });

    expect(issues).toEqual([]);
  });

  it('blocks only the unsupported scale claim when a block also contains an approved claim', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand({
        differentiators: ['自有大型车辆30+台。'],
      }),
      citations: [],
      content: content({
        blocks: [block('intro', '公司自有大型车辆30余台，同时拥有80名专职客服。')],
      }),
      platformCode: 'official_site',
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      rule_id: 'deterministic.fact.unsupported_scale',
    });
    expect(issues[0]?.message).toContain('拥有80名');
    expect(issues[0]?.message).not.toContain('30余台');
  });

  it('does not mistake per-vehicle crew configuration for enterprise scale', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({
        blocks: [block('vehicle-plan', '面包车套餐配备2人，厢式货车套餐配备3人。')],
      }),
      platformCode: 'official_site',
    });

    expect(issues.map((item) => item.rule_id)).not.toContain(
      'deterministic.fact.unsupported_scale',
    );
  });

  it('continues to block an unsupported enterprise staffing scale', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({ blocks: [block('scale', '公司目前配备80名专职员工。')] }),
      platformCode: 'official_site',
    });

    expect(issues.map((item) => item.rule_id)).toContain('deterministic.fact.unsupported_scale');
  });

  it('does not treat a numbered fee explanation as a concrete unsupported price', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({
        blocks: [block('price', '搬家费用通常包含3个部分，具体报价以现场需求评估为准。')],
      }),
      platformCode: 'official_site',
    });

    expect(issues.map((item) => item.rule_id)).not.toContain(
      'deterministic.fact.unsupported_price',
    );
  });

  it('does not mistake generic address guidance ending in 型号 for a detailed address', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({
        blocks: [block('checklist', '记录搬运地址、搬入地址、物品名称、数量、品牌型号后再签字。')],
      }),
      platformCode: 'official_site',
    });

    expect(issues.map((item) => item.rule_id)).not.toContain(
      'deterministic.fact.unsupported_address',
    );
  });

  it('continues to block an unsupported detailed street address', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({
        blocks: [block('address', '公司地址：广州市天河区体育西路123号。')],
      }),
      platformCode: 'official_site',
    });

    expect(issues.map((item) => item.rule_id)).toContain('deterministic.fact.unsupported_address');
  });

  it('accepts an exact price from a cited grouped company quotation', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          quoteText: '纸箱小中大：12/15/20 元一个；气泡膜3元一米。',
        },
      ],
      content: content({
        blocks: [block('price', '报价单列明小号纸箱12元、中号纸箱15元。')],
      }),
      platformCode: 'official_site',
    });

    expect(issues.map((item) => item.rule_id)).not.toContain(
      'deterministic.fact.unsupported_price',
    );
  });

  it('blocks identifiable company names while allowing the owner and anonymous companies', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({
        blocks: [
          block(
            'comparison',
            '广州志远搬家服务有限公司建议先核对合同。某公司、某搬家公司或其他服务商也应采用相同核对标准。广州家盛搬家有限公司、广州四通搬家有限公司和企查查不得直接出现在文章中。',
          ),
        ],
      }),
      platformCode: 'official_site',
    });

    const companyIssues = issues.filter(
      (item) => item.rule_id === 'deterministic.brand.other_company_name',
    );
    expect(companyIssues).toHaveLength(3);
    expect(companyIssues.map((item) => item.message).join('\n')).toContain('广州家盛搬家有限公司');
    expect(companyIssues.map((item) => item.message).join('\n')).toContain('广州四通搬家有限公司');
    expect(companyIssues.map((item) => item.message).join('\n')).toContain('企查查');
    expect(companyIssues.map((item) => item.message).join('\n')).not.toContain('某公司');
    expect(companyIssues.every((item) => item.severity === 'BLOCK')).toBe(true);
  });

  it('keeps blocking a derived or mistyped amount that is absent from the quotation', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          quoteText: '纸箱小中大：12/15/20 元一个；家庭立式钢琴3500元；车辆起步费¥4500。',
        },
      ],
      content: content({
        blocks: [block('price', '一次搬运测算总价为1634元，钢琴搬运价格为35元，车辆起步费¥450。')],
      }),
      platformCode: 'official_site',
    });

    expect(
      issues.filter((item) => item.rule_id === 'deterministic.fact.unsupported_price'),
    ).toHaveLength(3);
  });

  it('does not scan an opaque official-site slug as a telephone number', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({
        platform_meta: {
          faq: [{ answer: '先确认服务范围。', question: '搬家前准备什么？' }],
          meta_description: '仓库搬迁执行指南。',
          schema_org: { '@context': 'https://schema.org', '@type': 'Article' },
          slug: 'news-0f3b039983025147',
        },
      }),
      platformCode: 'official_site',
    });

    expect(issues.map((item) => item.rule_id)).not.toContain(
      'deterministic.fact.unsupported_phone',
    );
  });

  it('treats yuan and colloquial kuai as the same quoted currency unit', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          quoteText: '超出10公里部分按照7块钱1公里收费。',
        },
      ],
      content: content({
        blocks: [block('price', '超出约定里程后按报价单所列7元/公里计费。')],
      }),
      platformCode: 'official_site',
    });

    expect(issues.map((item) => item.rule_id)).not.toContain(
      'deterministic.fact.unsupported_price',
    );
  });

  it('blocks unsupported price, phone, scale, credentials, promises, secrets and brand bans', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand({ banned: ['零风险'] }),
      citations: [],
      content: content({
        blocks: [
          block('price', '基础套餐收费199元，拥有80台车辆，联系电话13800138000。'),
          block('credential', '公司荣获国家级AAA认证，是广州行业第一。'),
          block('secret', 'API_KEY=sk-1234567890abcdefghijklmnop，保证服务零风险。'),
        ],
      }),
      platformCode: 'official_site',
    });

    expect(new Set(issues.map((item) => item.rule_id))).toEqual(
      new Set([
        'deterministic.brand.banned_phrase',
        'deterministic.compliance.absolute_claim',
        'deterministic.fact.external_credential_requires_evidence',
        'deterministic.fact.unsupported_phone',
        'deterministic.fact.unsupported_price',
        'deterministic.fact.unsupported_scale',
        'deterministic.official_site.service_phone_required',
        'deterministic.security.secret_leakage',
      ]),
    );
    expect(issues.every((item) => item.severity === 'BLOCK')).toBe(true);
  });

  it('requires external evidence for credentials even when the brand profile mentions them', () => {
    const input = {
      brandProfile: brand({ compliance: ['公司已获得AAA企业信用认证'] }),
      content: content({
        blocks: [block('credential', '公司已获得AAA企业信用认证。')],
      }),
      platformCode: 'official_site' as const,
    };

    expect(
      scanDeterministicRisks({ ...input, citations: [] }).map((item) => item.rule_id),
    ).toContain('deterministic.fact.external_credential_requires_evidence');
    expect(
      scanDeterministicRisks({
        ...input,
        citations: [
          {
            claimText: '公司已获得AAA企业信用认证。',
            credentialAuthorized: true,
            id: '10000000-0000-4000-8000-000000000001',
            quoteText:
              '资料类型：企业证照\n证照名称：AAA企业信用认证证书\n持证主体：广州志远搬家服务有限公司',
          },
        ],
      }).map((item) => item.rule_id),
    ).not.toContain('deterministic.fact.external_credential_requires_evidence');
  });

  it('requires every stated credential to have a structured certificate citation', () => {
    const input = {
      brandProfile: brand(),
      content: content({
        blocks: [block('credential', '公司持有营业执照，并持有道路运输经营许可证。')],
      }),
      platformCode: 'lieju' as const,
    };
    const businessLicense = {
      claimText: '公司持有营业执照，并持有道路运输经营许可证。',
      credentialAuthorized: true,
      id: '10000000-0000-4000-8000-000000000011',
      quoteText: '资料类型：企业证照\n证照名称：营业执照\n持证主体：广州志远搬家服务有限公司',
    };
    const transportPermit = {
      claimText: '公司持有营业执照，并持有道路运输经营许可证。',
      credentialAuthorized: true,
      id: '10000000-0000-4000-8000-000000000012',
      quoteText:
        '资料类型：企业证照\n证照名称：道路运输经营许可证\n持证主体：广州志远搬家服务有限公司',
    };

    expect(
      scanDeterministicRisks({ ...input, citations: [businessLicense] }).map(
        (item) => item.rule_id,
      ),
    ).toContain('deterministic.fact.external_credential_requires_evidence');
    expect(
      scanDeterministicRisks({ ...input, citations: [businessLicense, transportPermit] }).map(
        (item) => item.rule_id,
      ),
    ).not.toContain('deterministic.fact.external_credential_requires_evidence');
  });

  it('requires every listed credential and the exact current holder', () => {
    const input = {
      brandProfile: brand(),
      content: content({
        blocks: [
          block(
            'credential',
            '公司持有营业执照、道路运输证和道路运输经营许可证，可按证照范围提供服务。',
          ),
        ],
      }),
      platformCode: 'lieju' as const,
    };
    const citations = [
      ['营业执照', '广州志远搬家服务有限公司'],
      ['道路运输证', '广州志远搬家服务有限公司'],
      ['道路运输经营许可证', '广州其他搬家服务有限公司'],
    ].map(([name, holder], index) => ({
      claimText: '公司持有营业执照、道路运输证和道路运输经营许可证，可按证照范围提供服务。',
      credentialAuthorized: true,
      id: `10000000-0000-4000-8000-00000000002${index}`,
      quoteText: `资料类型：企业证照\n证照名称：${name}\n持证主体：${holder}`,
    }));

    expect(scanDeterministicRisks({ ...input, citations }).map((item) => item.rule_id)).toContain(
      'deterministic.fact.external_credential_requires_evidence',
    );
    expect(
      scanDeterministicRisks({
        ...input,
        citations: [
          ...citations.slice(0, 2),
          {
            ...citations[2]!,
            quoteText:
              '资料类型：企业证照\n证照名称：道路运输经营许可证\n持证主体：广州志远搬家服务有限公司',
          },
        ],
      }).map((item) => item.rule_id),
    ).not.toContain('deterministic.fact.external_credential_requires_evidence');
  });

  it.each([
    '公司有道路运输经营许可证。',
    '营业执照、道路运输经营许可证齐全。',
    '道路运输经营许可证在有效期内。',
  ])('blocks an uncited affirmative credential form: %s', (statement) => {
    expect(
      scanDeterministicRisks({
        brandProfile: brand(),
        citations: [],
        content: content({ blocks: [block('credential', statement)] }),
        platformCode: 'lieju',
      }).map((item) => item.rule_id),
    ).toContain('deterministic.fact.external_credential_requires_evidence');
  });

  it.each([
    '请核验营业执照与道路运输证照是否齐全。',
    '选择服务商时，应确认其是否具备道路运输经营许可证。',
    '建议选择具备营业执照的搬家公司。',
  ])('does not treat credential verification guidance as an owner credential claim: %s', (text) => {
    expect(
      scanDeterministicRisks({
        brandProfile: brand(),
        citations: [],
        content: content({ blocks: [block('credential-guidance', text)] }),
        platformCode: 'lieju',
      }).map((item) => item.rule_id),
    ).not.toContain('deterministic.fact.external_credential_requires_evidence');
  });

  it('does not let credential guidance hide a later owner credential claim', () => {
    expect(
      scanDeterministicRisks({
        brandProfile: brand(),
        citations: [],
        content: content({
          blocks: [
            block(
              'credential-guidance-and-claim',
              '建议选择具备营业执照的搬家公司，公司持有道路运输经营许可证。',
            ),
          ],
        }),
        platformCode: 'lieju',
      }).map((item) => item.rule_id),
    ).toContain('deterministic.fact.external_credential_requires_evidence');
  });

  it('does not let later credential guidance hide an earlier owner credential claim', () => {
    expect(
      scanDeterministicRisks({
        brandProfile: brand(),
        citations: [],
        content: content({
          blocks: [
            block(
              'credential-claim-and-guidance',
              '公司持有营业执照，请核验服务商是否具备道路运输经营许可证。',
            ),
          ],
        }),
        platformCode: 'lieju',
      }).map((item) => item.rule_id),
    ).toContain('deterministic.fact.external_credential_requires_evidence');
  });

  it('requires evidence only for the owner claim when guidance and a claim share a sentence', () => {
    const statement = '建议选择具备营业执照的搬家公司，公司持有道路运输经营许可证。';
    expect(
      scanDeterministicRisks({
        brandProfile: brand(),
        citations: [
          {
            claimText: '公司持有道路运输经营许可证。',
            credentialAuthorized: true,
            id: '10000000-0000-4000-8000-000000000039',
            quoteText:
              '资料类型：企业证照\n证照名称：道路运输经营许可证\n持证主体：广州志远搬家服务有限公司',
          },
        ],
        content: content({ blocks: [block('credential-guidance-and-supported-claim', statement)] }),
        platformCode: 'lieju',
      }).map((item) => item.rule_id),
    ).not.toContain('deterministic.fact.external_credential_requires_evidence');
  });

  it('does not accept an unauthorized certificate or an unrelated citation mapping', () => {
    const statement = '公司持有营业执照和道路运输经营许可证。';
    const base = {
      brandProfile: brand(),
      content: content({ blocks: [block('credential', statement)] }),
      platformCode: 'lieju' as const,
    };
    const citations = [
      {
        claimText: '公司持有营业执照。',
        credentialAuthorized: true,
        id: '10000000-0000-4000-8000-000000000031',
        quoteText: '资料类型：企业证照\n证照名称：营业执照\n持证主体：广州志远搬家服务有限公司',
      },
      {
        claimText: '车辆安排以现场确认为准。',
        credentialAuthorized: true,
        id: '10000000-0000-4000-8000-000000000032',
        quoteText:
          '资料类型：企业证照\n证照名称：道路运输经营许可证\n持证主体：广州志远搬家服务有限公司',
      },
    ];

    expect(scanDeterministicRisks({ ...base, citations }).map((item) => item.rule_id)).toContain(
      'deterministic.fact.external_credential_requires_evidence',
    );
    expect(
      scanDeterministicRisks({
        ...base,
        citations: [
          citations[0]!,
          { ...citations[1]!, claimText: statement, credentialAuthorized: false },
        ],
      }).map((item) => item.rule_id),
    ).toContain('deterministic.fact.external_credential_requires_evidence');
  });

  it('blocks missing official-site technical GEO fields and merges with model output', () => {
    const deterministic = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({
        platform_meta: { faq: [], meta_description: '', schema_org: {}, slug: '' },
      }),
      platformCode: 'official_site',
    });
    const merged = mergeDeterministicRiskIssues(assessment(), deterministic);

    expect(merged.decision).toBe('block');
    expect(merged.score).toBe(92);
    expect(new Set(merged.issues.map((item) => item.rule_id))).toEqual(
      new Set([
        'deterministic.official_site.faq_required',
        'deterministic.official_site.meta_description_required',
        'deterministic.official_site.schema_org_required',
        'deterministic.official_site.slug_required',
      ]),
    );
  });

  it.each([
    ['广州志远搬家服务有限公司', '内容中出现禁止的公司名称“广州志远搬家服务有限公司”。'],
    ['某公司', '内容中出现禁止的公司名称“某公司”。'],
    ['某搬家公司', '内容中出现禁止的公司名称“某搬家公司”。'],
    ['某银行', '内容中出现禁止的公司名称“某银行”。'],
  ])('drops an unsupported model company-name block for allowed reference %s', (name, message) => {
    const candidate = content({ blocks: [block('company', `${name}建议先核对合同。`)] });
    const merged = mergeDeterministicRiskIssues(
      {
        ...assessment(),
        decision: 'block',
        issues: [
          {
            category: 'brand',
            citation_ids: [],
            location: 'blocks.company',
            message,
            rule_id: 'brand.other_company_name',
            severity: 'BLOCK',
            suggestion: '删除公司名称。',
          },
        ],
        score: 35,
      },
      [],
      candidate,
      brand(),
    );

    expect(merged.issues).toEqual([]);
    expect(merged.decision).toBe('pass');
    expect(merged.score).toBe(35);
  });

  it.each([
    'official_site',
    'baijiahao',
    'toutiao',
    'zhihu',
    'xiaohongshu',
    'wechat_mp',
    'douyin',
  ] as const)('reconciles the same false model company-name block for %s', (platformCode) => {
    const candidate = content({
      blocks: [block('company', '广州志远搬家服务有限公司建议先核对合同。')],
      platform_code: platformCode,
    });
    const merged = mergeDeterministicRiskIssues(
      {
        ...assessment(),
        decision: 'block',
        issues: [
          {
            category: 'brand',
            citation_ids: [],
            location: 'blocks.company',
            message: '内容中出现禁止的公司名称“广州志远搬家服务有限公司”。',
            rule_id: 'brand.other_company_name',
            severity: 'BLOCK',
            suggestion: '删除公司名称。',
          },
        ],
        score: 35,
      },
      [],
      candidate,
      brand(),
    );

    expect(merged.decision).toBe('pass');
    expect(merged.issues).toEqual([]);
  });

  it('keeps a model company-name block when the named third-party brand is present', () => {
    const candidate = content({ blocks: [block('company', '可通过货拉拉安排运输。')] });
    const merged = mergeDeterministicRiskIssues(
      {
        ...assessment(),
        decision: 'block',
        issues: [
          {
            category: 'brand',
            citation_ids: [],
            location: 'blocks.company',
            message: '内容包含禁止的第三方品牌“货拉拉”。',
            rule_id: 'brand.other_company_name',
            severity: 'BLOCK',
            suggestion: '改为匿名表述。',
          },
        ],
        score: 35,
      },
      [],
      candidate,
    );

    expect(merged.issues).toHaveLength(1);
    expect(merged.decision).toBe('block');
  });

  it('allows only the owner declared by the current tenant brand profile', () => {
    const owner = '广州众人搬家起重吊装有限公司';
    const otherTenant = '广州志远搬家服务有限公司';
    const issues = scanDeterministicRisks({
      brandProfile: brand({ positioning: `${owner}面向广州提供搬迁服务。` }),
      citations: [],
      content: content({
        blocks: [block('company', `${owner}可说明服务边界；${otherTenant}不得出现在本文。`)],
      }),
      platformCode: 'official_site',
    });

    const companyIssues = issues.filter(
      (item) => item.rule_id === 'deterministic.brand.other_company_name',
    );
    expect(companyIssues).toHaveLength(1);
    expect(companyIssues[0]?.message).toContain(otherTenant);
    expect(companyIssues[0]?.message).not.toContain(owner);
  });

  it('drops an unquoted model company-name block because it has no verifiable target', () => {
    const candidate = content({ blocks: [block('company', '建议先核对服务合同。')] });
    const merged = mergeDeterministicRiskIssues(
      {
        ...assessment(),
        decision: 'block',
        issues: [
          {
            category: 'brand',
            citation_ids: [],
            location: 'blocks.company',
            message: '内容疑似包含不允许公开的第三方品牌。',
            rule_id: 'brand.other_company_name',
            severity: 'BLOCK',
            suggestion: '核对并匿名化第三方名称。',
          },
        ],
        score: 35,
      },
      [],
      candidate,
    );

    expect(merged.issues).toEqual([]);
    expect(merged.decision).toBe('pass');
  });

  it('blocks Baijiahao diversion fields and invalid platform structure deterministically', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({
        blocks: [
          block(
            'intro',
            '扫码关注公众号：example，联系电话13800138000，访问https://example.test。',
          ),
        ],
        cta: '立即咨询',
        platform_code: 'baijiahao',
        platform_meta: { abstract: '摘要', tags: ['搬家'] },
        title: '百家号内容',
      }),
      platformCode: 'baijiahao',
    });

    expect(issues.map((item) => item.rule_id)).toEqual(
      expect.arrayContaining([
        'deterministic.baijiahao.cta_forbidden',
        'deterministic.baijiahao.external_account_forbidden',
        'deterministic.baijiahao.external_url_forbidden',
        'deterministic.baijiahao.phone_forbidden',
        'deterministic.baijiahao.qr_code_forbidden',
        'deterministic.baijiahao.structure_minimum',
        'deterministic.baijiahao.tag_count',
      ]),
    );
  });

  it('allows bounded Lieju service promotion and a page-contact CTA', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({
        blocks: [
          block(
            'service',
            '广州志远搬家服务有限公司可根据物品范围、楼层条件和搬运时间安排搬家服务，具体方案需在核对现场条件后确认。',
          ),
        ],
        cta: '可通过页面联系方式说明搬运需求。',
        platform_code: 'lieju',
        platform_meta: { content_type: 'logistics_freight' },
        title: '广州搬家服务准备说明',
      }),
      platformCode: 'lieju',
    });

    expect(issues.filter((item) => item.category === 'compliance')).toEqual([]);
  });

  it('blocks phone and account details in Lieju content while allowing URLs', () => {
    const issues = scanDeterministicRisks({
      brandProfile: {
        ...brand(),
        contact: { phone: '02085627757', website: 'https://example.test' },
      },
      citations: [],
      content: content({
        blocks: [
          block(
            'contact',
            '欢迎致电02085627757，或访问https://example.test，也可添加微信 zybj2026。',
          ),
        ],
        platform_code: 'lieju',
        platform_meta: { content_type: 'logistics_freight' },
        title: '广州搬家服务联系方式',
      }),
      platformCode: 'lieju',
    });

    expect(issues.map((item) => item.rule_id)).toEqual(
      expect.arrayContaining([
        'deterministic.lieju.external_account_forbidden',
        'deterministic.lieju.phone_forbidden',
      ]),
    );
    expect(issues.map((item) => item.rule_id)).not.toContain(
      'deterministic.lieju.external_url_forbidden',
    );
  });

  it('allows bare official-platform domains in Lieju verification guidance', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({
        blocks: [
          block(
            'verify-list',
            '营业执照可在国家企业信用信息公示系统（www.gsxt.gov.cn）核验，道路运输许可可在交通运输部官方平台（ysfw.mot.gov.cn）核验。',
          ),
        ],
        platform_code: 'lieju',
        platform_meta: { content_type: 'logistics_freight' },
        title: '广州搬家服务资质核验方法',
      }),
      platformCode: 'lieju',
    });

    expect(issues).toEqual([]);
  });

  it('blocks a Lieju promotional term before publishing even in a quoted warning', () => {
    const issues = scanDeterministicRisks({
      brandProfile: brand(),
      citations: [],
      content: content({
        blocks: [
          block(
            'risk-warning',
            '不要轻信“百分百满意”等绝对化承诺，服务方案应以实际需求和书面约定为准。',
          ),
        ],
        platform_code: 'lieju',
        platform_meta: { content_type: 'logistics_freight' },
        title: '广州搬家前如何核对承诺',
      }),
      platformCode: 'lieju',
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'compliance',
          location: 'blocks.risk-warning',
          message: '列举网待发布内容包含发布层禁止的宣传词“百分百”。',
          rule_id: 'deterministic.lieju.prohibited_promotional_term',
          severity: 'BLOCK',
          suggestion: '删除“百分百”原词；即使是否定、引用或举例，也必须改为不含该词的中性表达。',
        }),
      ]),
    );
  });
});

function assessment(): QualityCheckerData {
  return {
    decision: 'pass',
    geo_scores: {
      answerability: 90,
      entity: 90,
      evidence: 90,
      platform_fit: 90,
      question: 90,
      readability_safety: 90,
      total: 90,
    },
    issues: [],
    score: 92,
  };
}

function brand(
  overrides: Partial<{
    audience: readonly string[];
    banned: readonly string[];
    compliance: readonly string[];
    contact: Readonly<Record<string, unknown>>;
    cta: string | null;
    differentiators: readonly string[];
    positioning: string;
    tone: string;
  }> = {},
) {
  return {
    audience: ['需要搬家服务的企业和家庭'],
    banned: [],
    compliance: [],
    contact: { official_site_service_phone: '02085627757' },
    cta: null,
    differentiators: [],
    positioning: '广州志远搬家服务有限公司是广州本地搬家服务企业',
    tone: '专业、克制',
    ...overrides,
  };
}

function content(
  overrides: Partial<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const platformCode = overrides['platform_code'] ?? 'official_site';
  return {
    blocks: [
      block('intro', '本文说明广州企业搬家前的准备方法与执行步骤。'),
      block('checklist', '先确认物品范围，再安排车辆和人员。'),
    ],
    citation_map: [],
    cta: platformCode === 'official_site' ? '如需咨询服务，请致电 02085627757。' : null,
    hashtags: ['广州搬家'],
    platform_code: 'official_site',
    platform_meta: {
      faq: [{ answer: '先确认服务范围和时间。', question: '搬家前要准备什么？' }],
      meta_description: '了解广州企业搬家的准备步骤、人员安排和执行注意事项。',
      schema_org: { '@context': 'https://schema.org', '@type': 'Article' },
      slug: 'guangzhou-enterprise-moving-guide',
    },
    summary: '一份面向广州企业搬家的准备与执行指南。',
    title: '广州企业搬家前需要准备什么：从物品清单到人员安排',
    ...overrides,
  };
}

function block(key: string, text: string) {
  return { block_key: key, block_type: 'paragraph', text };
}
