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
        'deterministic.security.secret_leakage',
      ]),
    );
    expect(issues.every((item) => item.severity === 'BLOCK')).toBe(true);
  });

  it('requires external evidence for credentials even when the brand profile mentions them', () => {
    const input = {
      brandProfile: brand({ compliance: ['公司已获得AAA认证'] }),
      content: content({
        blocks: [block('credential', '公司已获得AAA认证。')],
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
            claimText: '公司已获得AAA认证。',
            id: '10000000-0000-4000-8000-000000000001',
          },
        ],
      }).map((item) => item.rule_id),
    ).not.toContain('deterministic.fact.external_credential_requires_evidence');
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
    cta: null,
    differentiators: [],
    positioning: '广州本地搬家服务企业',
    tone: '专业、克制',
    ...overrides,
  };
}

function content(
  overrides: Partial<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    blocks: [
      block('intro', '本文说明广州企业搬家前的准备方法与执行步骤。'),
      block('checklist', '先确认物品范围，再安排车辆和人员。'),
    ],
    citation_map: [],
    cta: null,
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
