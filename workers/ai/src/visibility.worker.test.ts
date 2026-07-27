import { describe, expect, it } from 'vitest';

import { analyzeVisibilityAnswer, scoreVisibility } from './visibility.worker.js';

const QUERY_IDS = Array.from(
  { length: 6 },
  (_, index) => `70000000-0000-4000-8000-00000000007${index}`,
);

describe('AI visibility deterministic analysis', () => {
  it('extracts target rank, competitors, sentiment and verifiable URLs', () => {
    const result = analyzeVisibilityAnswer(
      '1. 竞品甲：可先了解。\n2. 志远搬家：拥有正规、稳定的搬家服务团队，值得考虑。资料：https://example.com/guide。',
      {
        aliases: ['广州志远搬家'],
        brandName: '志远搬家',
        competitors: ['竞品甲', '竞品乙'],
        industry: '搬家服务',
        intentCode: 'recommendation',
        market: '广州',
        positioning: '正规团队',
      },
    );

    expect(result).toMatchObject({
      competitorsMentioned: ['竞品甲'],
      recommended: true,
      recognitionStatus: 'not_applicable',
      sentiment: 'positive',
      targetMentioned: true,
      targetRank: 2,
    });
    expect(result.citations).toEqual([
      { domain: 'example.com', title: null, url: 'https://example.com/guide' },
    ]);
  });

  it('uses explicit rankings and distinguishes recognition from misidentification', () => {
    const orderedOnly = analyzeVisibilityAnswer('先介绍竞品甲，之后介绍志远搬家。', {
      aliases: [],
      brandName: '志远搬家',
      competitors: ['竞品甲', '竞品乙'],
      industry: '搬家服务',
      intentCode: 'recommendation',
      market: '广州',
      positioning: null,
    });
    const misidentified = analyzeVisibilityAnswer('志远搬家就是竞品甲，主要提供搬家服务。', {
      aliases: [],
      brandName: '志远搬家',
      competitors: ['竞品甲', '竞品乙'],
      industry: '搬家服务',
      intentCode: 'brand_recognition',
      market: '广州',
      positioning: null,
    });

    expect(orderedOnly.targetRank).toBeNull();
    expect(misidentified.recognitionStatus).toBe('misidentified');
  });

  it('calculates the frozen score and identifies high-value zero-hit questions', () => {
    const rows = [
      row(0, 'brand_recognition', true, 1, 'positive', true, []),
      row(1, 'exploration', true, 2, 'positive', false, ['竞品甲']),
      row(2, 'recommendation', false, null, 'unknown', false, ['竞品甲']),
      row(3, 'comparison', false, null, 'unknown', false, ['竞品乙']),
      row(4, 'education', true, 1, 'neutral', false, []),
      row(5, 'procurement', false, null, 'unknown', false, ['竞品甲']),
    ];
    const result = scoreVisibility(rows, ['竞品甲', '竞品乙']);

    expect(result.metrics).toMatchObject({
      answered_count: 6,
      average_rank: null,
      mention_rate: 0.5,
      misidentified_count: 0,
      natural_answered_count: 4,
      positive_sentiment_rate: 0.6667,
      ranked_count: 0,
      recognized_count: 1,
      recognition_rate: 1,
      recommendation_rate: 0,
      score: 56.67,
      total_count: 6,
    });
    expect(result.competitors[0]).toMatchObject({ name: '竞品甲', mention_count: 3 });
    expect(result.opportunities.map((item) => item.intent_code)).toEqual([
      'recommendation',
      'comparison',
      'procurement',
    ]);
  });
});

function row(
  index: number,
  intentCode:
    | 'brand_recognition'
    | 'comparison'
    | 'education'
    | 'exploration'
    | 'procurement'
    | 'recommendation',
  targetMentioned: boolean,
  targetRank: number | null,
  sentiment: 'negative' | 'neutral' | 'positive' | 'unknown',
  recommended: boolean,
  competitors: readonly string[],
) {
  return {
    answerText: '测试回答',
    citations: [],
    commercialValue: ['recommendation', 'comparison', 'procurement'].includes(intentCode)
      ? ('high' as const)
      : ('medium' as const),
    competitors,
    error: null,
    id: QUERY_IDS[index]!,
    intentCode,
    queryKey: `q00${index + 1}`,
    queryText: `测试问题 ${index + 1}`,
    recommended,
    recognitionStatus:
      intentCode === 'brand_recognition' ? ('recognized' as const) : ('not_applicable' as const),
    sentiment,
    targetMentioned,
    targetRank,
  };
}
