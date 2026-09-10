import { describe, expect, it } from 'vitest';
import {
  AccountContentPolicyRequestSchema,
  editorialAllowedCompanyNames,
  freezeEditorialContext,
  recommendationEvidenceModeInstruction,
  readWriterEditorialContext,
  resolveEditorialStyle,
  supportsEditorialStyle,
  type AccountContentPolicyView,
} from './editorial-policy.js';

const policy: AccountContentPolicyView = {
  account_id: '11111111-1111-4111-8111-111111111111',
  default_style: 'company_recommendation',
  platform_code: 'douyin',
  recommended_companies: [
    {
      id: '21111111-1111-4111-8111-111111111111',
      legal_name: '广东众人搬家起重吊装有限公司',
      source_document_ids: ['31111111-1111-4111-8111-111111111111'],
    },
    {
      id: '41111111-1111-4111-8111-111111111111',
      legal_name: '广州志远搬家服务有限公司',
      source_document_ids: ['51111111-1111-4111-8111-111111111111'],
    },
  ],
  version: 2,
  workspace_id: '61111111-1111-4111-8111-111111111111',
};

describe('account editorial policy', () => {
  it('allows automatic primary and explicitly inherited service sources without uploading documents', () => {
    const snapshot = freezeEditorialContext({
      ...policy,
      recommended_companies: policy.recommended_companies.map((company, index) => ({
        ...company,
        source_document_ids: [],
        evidence_mode: index === 0 ? 'primary' : 'inherit_primary',
      })),
    });
    expect(snapshot.companies.every((company) => company.source_document_ids.length === 0)).toBe(
      true,
    );
    expect(recommendationEvidenceModeInstruction(snapshot)).toContain('不包含证照');
    expect(recommendationEvidenceModeInstruction(snapshot)).toContain(
      policy.recommended_companies[1]!.legal_name,
    );
  });
  it('requires a server-saved description source and does not accept source IDs from policy requests', () => {
    const company = {
      ...policy.recommended_companies[1]!,
      source_document_ids: [],
      evidence_mode: 'description' as const,
      business_description: '主要提供旧空调及二手家电回收服务。',
    };
    expect(() =>
      freezeEditorialContext({
        ...policy,
        recommended_companies: [policy.recommended_companies[0]!, company],
      }),
    ).toThrow();
    const saved = { ...company, description_source_id: policy.workspace_id };
    expect(
      freezeEditorialContext({
        ...policy,
        recommended_companies: [policy.recommended_companies[0]!, saved],
      }).companies[1]?.description_source_id,
    ).toBe(policy.workspace_id);
    expect(
      AccountContentPolicyRequestSchema.safeParse({
        expected_version: 0,
        default_style: 'company_recommendation',
        recommended_companies: [saved],
      }).success,
    ).toBe(false);
  });
  it.each(['official_site', 'lieju', 'douyin'])('supports %s', (platform) => {
    expect(supportsEditorialStyle(platform)).toBe(true);
  });
  it.each(['baijiahao', 'sohu', 'toutiao', 'zhihu', 'xiaohongshu', 'wechat_mp'])(
    'excludes %s even with inherited metadata',
    (platform) => {
      expect(supportsEditorialStyle(platform)).toBe(false);
      expect(
        readWriterEditorialContext(
          {
            brief: {
              constraints: {
                editorial_contexts_by_code: { [platform]: freezeEditorialContext(policy) },
              },
            },
          },
          platform,
        ),
      ).toBeNull();
    },
  );
  it('resolves single-request, daily and account precedence', () => {
    expect(resolveEditorialStyle()).toBe('standard');
    expect(resolveEditorialStyle('standard', 'company_recommendation')).toBe(
      'company_recommendation',
    );
    expect(resolveEditorialStyle('company_recommendation', 'standard')).toBe('standard');
    expect(resolveEditorialStyle('standard', 'standard', 'company_recommendation')).toBe(
      'company_recommendation',
    );
  });
  it('freezes a detached ordered list and never promotes it in standard mode', () => {
    const snapshot = freezeEditorialContext(policy);
    expect(snapshot.companies).toEqual(policy.recommended_companies);
    expect(snapshot.companies).not.toBe(policy.recommended_companies);
    const standard = freezeEditorialContext(policy, 'standard');
    expect(standard.companies).toEqual([]);
    expect(editorialAllowedCompanyNames(['发布主体'], standard)).toEqual(['发布主体']);
    expect(editorialAllowedCompanyNames(['发布主体'], snapshot)).toEqual([
      '发布主体',
      ...policy.recommended_companies.map((company) => company.legal_name),
    ]);
  });
  it('allows incomplete settings to be saved but refuses generation', () => {
    expect(
      AccountContentPolicyRequestSchema.safeParse({
        default_style: 'company_recommendation',
        expected_version: 0,
        recommended_companies: [],
      }).success,
    ).toBe(true);
    expect(() => freezeEditorialContext({ ...policy, recommended_companies: [] })).toThrow();
    expect(() =>
      freezeEditorialContext({
        ...policy,
        recommended_companies: policy.recommended_companies.slice(0, 1),
      }),
    ).toThrow();
  });
  it('rejects duplicate companies, unbound evidence and unknown settings', () => {
    const request = {
      default_style: 'standard',
      expected_version: 0,
      recommended_companies: [policy.recommended_companies[0], policy.recommended_companies[0]],
    };
    expect(AccountContentPolicyRequestSchema.safeParse(request).success).toBe(false);
    expect(
      AccountContentPolicyRequestSchema.safeParse({
        ...request,
        recommended_companies: [],
        tenant_id: policy.workspace_id,
      }).success,
    ).toBe(false);
    expect(() =>
      freezeEditorialContext({
        ...policy,
        recommended_companies: policy.recommended_companies.map((company) => ({
          ...company,
          source_document_ids: [],
        })),
      }),
    ).toThrow();
  });
  it('requires the frozen target account to match', () => {
    const context = freezeEditorialContext(policy);
    const input = {
      brief: {
        constraints: {
          editorial_contexts_by_code: { douyin: context },
          target_accounts_by_code: { douyin: { account_id: policy.account_id } },
        },
      },
    };
    expect(readWriterEditorialContext(input, 'douyin')).toEqual(context);
    input.brief.constraints.target_accounts_by_code.douyin.account_id = policy.workspace_id;
    expect(() => readWriterEditorialContext(input, 'douyin')).toThrow('目标账号');
  });
});
