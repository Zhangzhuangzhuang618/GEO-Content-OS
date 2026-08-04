import { describe, expect, it } from 'vitest';

import {
  assessBaijiahaoSourceSuitability,
  buildBaijiahaoRewriteDiagnostics,
  nextBaijiahaoScheduleAt,
  sourceSimilarity,
  type BaijiahaoAutomationPolicy,
  type BaijiahaoQualityGate,
} from './baijiahao-automation.js';
import type { GeneratedContent } from './generation.types.js';

describe('Baijiahao automation safeguards', () => {
  it('accepts only substantial informational official-site sources', () => {
    expect(assessBaijiahaoSourceSuitability(article('甲'.repeat(900)), 'education')).toBeNull();
    expect(assessBaijiahaoSourceSuitability(article('甲'.repeat(900)), 'conversion')).toBe(
      'objective_not_informational',
    );
    expect(assessBaijiahaoSourceSuitability(article('内容较短'), 'education')).toBe(
      'source_too_short',
    );
    expect(
      assessBaijiahaoSourceSuitability(
        article(`${'甲'.repeat(900)}立即咨询，免费报价，扫码加微信。`),
        'education',
      ),
    ).toBe('source_too_promotional');
  });

  it('detects verbatim and highly similar derived copy', () => {
    const source = article('搬家前应先建立物品清单并确认现场通道。'.repeat(60));
    expect(sourceSimilarity(source, source)).toBe(1);
    expect(
      sourceSimilarity(source, article('企业迁址时需要明确责任人和分阶段验收。'.repeat(60))),
    ).toBeLessThan(0.82);
  });

  it('turns frozen gate failures into bounded rewrite instructions without inventing facts', () => {
    const diagnostics = buildBaijiahaoRewriteDiagnostics(policy(), gate(), [
      {
        category: 'fact',
        citation_ids: [],
        location: 'blocks[2]',
        message: '价格没有证据。',
        rule_id: 'deterministic.fact.unsupported_price',
        severity: 'BLOCK',
        suggestion: '删除金额。',
      },
    ]);

    expect(diagnostics.join('\n')).toContain('删除金额');
    expect(diagnostics.join('\n')).toContain('必须低于 0.82');
    expect(diagnostics.join('\n')).toContain('不得改变事实和证据');
    expect(diagnostics).toHaveLength(2);
  });

  it('gives an actionable title repair when question coverage misses the frozen threshold', () => {
    const diagnostics = buildBaijiahaoRewriteDiagnostics(
      policy(),
      {
        ...gate(),
        blocking_rules: ['gate.question_coverage'],
        question_coverage: 72,
        source_similarity: 0.5,
      },
      [],
    );

    expect(diagnostics).toEqual([expect.stringContaining('问题覆盖分为 72，最低要求 80')]);
    expect(diagnostics[0]).toContain('明确问题式标题');
    expect(diagnostics[0]).toContain('2—40 字');
    expect(diagnostics[0]).toContain('不得虚构或填充');
  });

  it('uses each future Shanghai schedule slot once before moving to the next day', () => {
    const now = new Date('2026-08-02T00:30:00.000Z');
    const first = new Date('2026-08-02T01:30:00.000Z');
    expect(nextBaijiahaoScheduleAt(now, ['08:00:00', '09:30:00'])).toEqual(first);
    expect(nextBaijiahaoScheduleAt(now, ['08:00:00', '09:30:00'], [first])).toEqual(
      new Date('2026-08-03T00:00:00.000Z'),
    );
  });
});

function article(body: string): GeneratedContent {
  return {
    blocks: [
      block('intro', body),
      block('heading-1', '准备阶段'),
      block('body-1', '先确认范围。'),
      block('heading-2', '执行阶段'),
      block('body-2', '再核对现场。'),
    ],
    platform_code: 'official_site',
    schema_version: 'generated-content@1',
  };
}

function block(key: string, text: string) {
  return { block_key: key, block_type: 'paragraph' as const, text };
}

function policy(): BaijiahaoAutomationPolicy {
  return {
    accountId: '00000000-0000-4000-8000-000000000001',
    brandConsistencyMin: 90,
    createdBy: '00000000-0000-4000-8000-000000000002',
    factualAccuracyMin: 90,
    geoTotalMin: 85,
    id: '00000000-0000-4000-8000-000000000003',
    maxRewrites: 3,
    maxSourceSimilarity: 0.82,
    platformFitMin: 80,
    publishAttemptLimit: 3,
    questionCoverageMin: 80,
    readabilitySafetyMin: 85,
    scheduleTimes: ['08:00:00'],
    sourceSimilarity: 0.9,
  };
}

function gate(): BaijiahaoQualityGate {
  return {
    blocking_rules: ['deterministic.baijiahao.source_similarity'],
    brand_consistency: 92,
    factual_accuracy: 92,
    geo_total: 88,
    passed: false,
    platform_fit: 88,
    question_coverage: 86,
    readability_safety: 88,
    schema_version: 'baijiahao-quality-gate@1',
    source_similarity: 0.9,
  };
}
