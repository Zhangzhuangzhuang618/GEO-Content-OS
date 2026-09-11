import { describe, expect, it } from 'vitest';
import {
  applyRecommendationContacts,
  assessRecommendationContacts,
  withoutRecommendationContacts,
  RecommendedCompanySchema,
  type EditorialContext,
} from './editorial-policy.js';
import {
  applyOfficialSiteServicePhone,
  hasExactOfficialSiteServicePhone,
} from './official-site-service-contact.js';

const companies = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    legal_name: '广东众人搬家起重吊装有限公司',
    source_document_ids: [],
    service_phone: '4008372383',
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    legal_name: '广州志远搬家服务有限公司',
    source_document_ids: [],
    service_phone: '02085627757',
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    legal_name: '广州盛源机电制冷工程有限公司',
    source_document_ids: [],
    service_phone: '18148943200',
  },
];
function fixture(platform: EditorialContext['platform_code']) {
  const context: EditorialContext = {
    account_id: companies[0]!.id,
    companies,
    platform_code: platform,
    policy_version: 1,
    schema_version: 'editorial-context@1',
    style: 'company_recommendation',
    template_version: 'company-recommendation@1',
  };
  const content = {
    platform_code: platform,
    blocks: companies.map((_, i) => ({
      block_key: `company_${i + 1}`,
      block_type: 'paragraph',
      text: '承接对应搬迁服务。',
    })),
    platform_meta: {
      description: companies.map((c) => `${c.legal_name}：承接对应搬迁服务。`).join('\n\n'),
    },
    cta: null as string | null,
  };
  return { context, content };
}
describe('configured recommendation contacts', () => {
  it.each(['official_site', 'lieju', 'douyin'] as const)(
    '%s binds each phone, is idempotent and preserves the input',
    (platform) => {
      const { context, content } = fixture(platform);
      const added = applyRecommendationContacts(content, context);
      expect(added.blocks).toHaveLength(6);
      expect(content.blocks).toHaveLength(3);
      expect(assessRecommendationContacts(added, context)).toEqual([]);
      expect(applyRecommendationContacts(added, context)).toEqual(added);
      const cleaned = withoutRecommendationContacts(added, context);
      expect(JSON.stringify(cleaned)).not.toMatch(/4008372383|02085627757|18148943200/);
    },
  );
  it('does not authorize a swapped phone, wrong location, or missing description phone', () => {
    const { context, content } = fixture('douyin');
    const added = applyRecommendationContacts(content, context);
    added.blocks[1]!.text = '联系电话：02085627757。';
    expect(assessRecommendationContacts(added, context).join()).toContain('冻结配置');
    expect(withoutRecommendationContacts(added, context).blocks[1]!.text).toContain('02085627757');
    added.platform_meta.description = content.platform_meta.description;
    expect(assessRecommendationContacts(added, context).join()).toContain('主文案');
  });
  it('keeps regular style and legacy snapshots unchanged', () => {
    const { context, content } = fixture('lieju');
    expect(
      applyRecommendationContacts(content, { ...context, style: 'standard', companies: [] }),
    ).toBe(content);
    const legacy = {
      ...context,
      companies: context.companies.map((company) => ({
        id: company.id,
        legal_name: company.legal_name,
        source_document_ids: company.source_document_ids,
      })),
    };
    expect(applyRecommendationContacts(content, legacy)).toEqual(content);
    expect(assessRecommendationContacts(content, legacy)).toEqual([]);
  });
  it('retains the official-site primary CTA and rejects unconfigured extra phones', () => {
    const { context, content } = fixture('official_site');
    const added = applyOfficialSiteServicePhone(
      applyRecommendationContacts(content, context),
      '4008372383',
    );
    expect(
      hasExactOfficialSiteServicePhone(withoutRecommendationContacts(added, context), '4008372383'),
    ).toBe(true);
    added.blocks[0]!.text += '请联系13900001111。';
    expect(
      hasExactOfficialSiteServicePhone(withoutRecommendationContacts(added, context), '4008372383'),
    ).toBe(false);
  });
  it('validates configured numbers without requiring phone evidence documents', () => {
    for (const company of companies)
      expect(RecommendedCompanySchema.safeParse(company).success).toBe(true);
    for (const value of ['020-85627757', 'abc', ''])
      expect(
        RecommendedCompanySchema.safeParse({ ...companies[0], service_phone: value }).success,
      ).toBe(false);
  });
});
