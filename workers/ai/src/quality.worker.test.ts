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
