import { expect, it } from 'vitest';
import { resolveRecommendationContext } from '@geo-content-os/retrieval';
import { freezeEditorialContext, type AccountContentPolicyView } from '@geo-content-os/contracts';

it('freezes the current primary phone for manual/daily generation without inheriting it into other companies', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const other = '21111111-1111-4111-8111-111111111111';
  const primary = '广东众人搬家起重吊装有限公司';
  const policy: AccountContentPolicyView = {
    account_id: id,
    workspace_id: id,
    version: 1,
    platform_code: 'douyin',
    default_style: 'company_recommendation',
    recommended_companies: [
      {
        id,
        legal_name: primary,
        evidence_mode: 'primary',
        source_document_ids: [],
        service_phone: '13900001111',
      },
      {
        id: other,
        legal_name: '广州志远搬家服务有限公司',
        evidence_mode: 'inherit_primary',
        source_document_ids: [],
        service_phone: '02085627757',
      },
    ],
  };
  let phone = '4008372383';
  const client = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    expect(values).toContain(id);
    if (query.includes('FROM brand_profiles')) return [{ profile: { positioning: primary } }];
    if (query.includes('FROM workspaces'))
      return [{ settings: { official_site_service_phone: phone } }];
    if (query.includes('FROM source_documents')) return [{ id, certificate: false }];
    throw new Error('Unexpected query');
  }) as unknown as Parameters<typeof resolveRecommendationContext>[0];
  const scope = { tenantId: id, workspaceId: id, projectId: id, userId: id };
  const frozen = await resolveRecommendationContext(client, scope, freezeEditorialContext(policy));
  expect(frozen.companies.map((company) => company.service_phone)).toEqual([
    '4008372383',
    '02085627757',
  ]);
  phone = '02012345678';
  expect(await resolveRecommendationContext(client, scope, frozen)).toBe(frozen);
  const next = await resolveRecommendationContext(client, scope, freezeEditorialContext(policy));
  expect(next.companies[0]!.service_phone).toBe(phone);
  expect(next.companies[1]!.service_phone).toBe('02085627757');
});
