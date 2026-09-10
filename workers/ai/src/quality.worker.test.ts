import { describe, expect, it } from 'vitest';

import { calculateGeoScores, groupCitations, type CitationRow } from './quality.worker.js';

const CONTENT = Object.freeze({
  blocks: Object.freeze([
    Object.freeze({
      block_key: 'direct-answer',
      block_type: 'paragraph',
      text: '选择搬家服务时，应先核对服务范围、执行人员、车辆计划和异常处理方式。',
    }),
    Object.freeze({
      block_key: 'scope-heading',
      block_type: 'heading',
      text: '核对服务范围',
    }),
    Object.freeze({
      block_key: 'scope-detail',
      block_type: 'paragraph',
      text: '把需要搬运的物品、楼层条件和时间要求写入清单。',
    }),
  ]),
  summary: '文章提供选择搬家服务时可直接使用的核对步骤和风险提示。',
  title: '广州家庭搬家前如何核对服务范围与执行人员安排',
});

describe('official-site fact support scoring', () => {
  it('scores questions present in delivered copy, not only interrogative titles', () => {
    const plain = { title: '广州搬迁服务介绍', summary: '服务介绍', blocks: [] };
    expect(calculateGeoScores(plain, [], 'douyin', {}, {}).question).toBe(72);
    for (const content of [
      {
        ...plain,
        blocks: [{ block_type: 'paragraph', text: '家具拆装是否另收费？预约时单独确认。' }],
      },
      {
        ...plain,
        platform_meta: { faq: [{ question: '哪些项目另收费？', answer: '家具拆装另收费。' }] },
      },
      {
        ...plain,
        platform_meta: { cards: [{ heading: '收费核对', body: '确认家具拆装是否另收费。' }] },
      },
    ])
      expect(calculateGeoScores(content, [], 'douyin', {}, {}).question).toBe(90);
    expect(
      calculateGeoScores(
        { ...plain, blocks: [{ text: '家具拆装是否另收费？' }] },
        [],
        'baijiahao',
        {},
        {},
      ).question,
    ).toBe(72);
    // Unpublished input and generic promotional copy must not earn the signal.
    expect(
      calculateGeoScores(
        { ...plain, brief: { title: '如何搬迁？' }, citations: [{ quote_text: '是否另收费？' }] },
        [],
        'douyin',
        {},
        {},
      ).question,
    ).toBe(72);
  });
  it('lets one directly supporting citation reach the evidence threshold', () => {
    const facts = groupCitations([
      citation(
        '广州志远搬家服务有限公司自有大型车辆30余台。',
        '企业资料显示，广州志远搬家服务有限公司自有大型车辆30余台。',
      ),
    ]);
    const scores = calculateGeoScores(CONTENT, facts, 'official_site', {}, {});

    expect(facts).toEqual([expect.objectContaining({ confidence: 0.98, verdict: 'supported' })]);
    expect(scores.evidence).toBe(95);
  });

  it('does not reward multiple unrelated citations', () => {
    const facts = groupCitations(
      Array.from({ length: 5 }, (_, index) =>
        citation(
          '广州志远搬家服务有限公司自有大型车辆30余台。',
          `第 ${index + 1} 条材料只介绍通用搬家准备事项，没有车辆数量信息。`,
          `00000000-0000-4000-8000-00000000000${index + 1}`,
        ),
      ),
    );
    const scores = calculateGeoScores(CONTENT, facts, 'official_site', {}, {});

    expect(facts[0]).toMatchObject({ verdict: 'unsupported' });
    expect(scores.evidence).toBe(25);
  });

  it('rejects a sensitive number when the evidence contains a different value', () => {
    const facts = groupCitations([
      citation(
        '广州志远搬家服务有限公司自有大型车辆30余台。',
        '企业资料显示该公司目前安排了20台车辆。',
      ),
    ]);

    expect(facts[0]).toMatchObject({ confidence: 0.15, verdict: 'unsupported' });
  });

  it('accepts published first-party profile facts when no external citation is claimed', () => {
    const scores = calculateGeoScores(
      CONTENT,
      [],
      'official_site',
      { company_name: '广州志远搬家服务有限公司' },
      { accepted_first_party_source: 'published_brand_profile' },
    );

    expect(scores.evidence).toBe(95);
  });
});

function citation(
  claimText: string,
  quoteText: string,
  id = '00000000-0000-4000-8000-000000000001',
): CitationRow {
  return Object.freeze({
    claimKey: 'company-scale',
    claimText,
    id,
    quoteText,
  });
}
