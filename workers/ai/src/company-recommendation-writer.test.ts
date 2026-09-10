import { describe, it, expect } from 'vitest';
import { recommendationWritingExampleForTopic } from './company-recommendation-examples.js';
import {
  assessCompanyRecommendation,
  assessDouyinOwnerPromotion,
  isRecommendationCardExcerpt,
  type EditorialContext,
} from '@geo-content-os/contracts';
import {
  recommendationContent,
  recommendationInstruction,
  recommendationCardInstruction,
  recommendationArticleSchema,
  assembleRecommendationDraft,
  normalizeRecommendationArticle,
  recommendationArticleFromContent,
  recommendationCardOptions,
  recommendationDraftSchema,
  preserveUnaffectedRecommendationCompanies,
  type RecommendationDraft,
} from './company-recommendation-writer.js';
import {
  selectRecommendationEvidence,
  RECOMMENDATION_EVIDENCE_PLAN_INSTRUCTION,
  recommendationEvidencePlanSchema,
  recommendationPlanOverlapIssues,
} from './recommendation-evidence-plan.js';
import {
  recommendationCompanySchema,
  recommendationFrameSchema,
  recommendationFrameInstruction,
  RECOMMENDATION_COMPANY_INSTRUCTION,
  recommendationCardSelectionSchema,
  recommendationCardExcerpts,
  applyRecommendationHeadings,
  recommendationFrameDuplicateIssues,
  recommendationProseIssues,
  recommendationRequiredNotice,
  recommendationCardChoiceIssues,
  preserveUnmentionedCompanySections,
  RECOMMENDATION_HEADING_INSTRUCTION,
  RECOMMENDATION_HEADING_REVIEW_INSTRUCTION,
} from './recommendation-stages.js';

it('asks heading generation and review to check readable relations and local item counts', () => {
  expect(RECOMMENDATION_HEADING_INSTRUCTION).toContain('不为塞进多个关键词省掉必要连接词');
  expect(RECOMMENDATION_HEADING_REVIEW_INSTRUCTION).toContain('标题能否独立读通');
  expect(RECOMMENDATION_HEADING_REVIEW_INSTRUCTION).toContain('本卡实际列出的事项，而非全文数量');
  expect(RECOMMENDATION_HEADING_REVIEW_INSTRUCTION).toContain('正常“家具拆装另收费”没有这个问题');
});

function fixture(count = 2) {
  const names = [
    '广东众人搬家起重吊装有限公司',
    '广州志远搬家服务有限公司',
    '广州测试甲有限公司',
    '广州测试乙有限公司',
    '广州测试丙有限公司',
    '广州测试丁有限公司',
  ];
  const context: EditorialContext = {
    account_id: '11111111-1111-4111-8111-111111111111',
    platform_code: 'douyin',
    policy_version: 1,
    schema_version: 'editorial-context@1',
    template_version: 'company-recommendation@1',
    style: 'company_recommendation',
    companies: names.slice(0, count).map((name, index) => ({
      id: `21111111-1111-4111-8111-11111111111${index}`,
      legal_name: name,
      source_document_ids: [`31111111-1111-4111-8111-11111111111${index}`],
    })),
  };
  const citations = context.companies.map((company, index) => ({
    citation_id: `41111111-1111-4111-8111-11111111111${index}`,
    source_id: company.source_document_ids[0]!,
    chunk_id: `41111111-1111-4111-8111-11111111111${index}`,
    quote_text: '提供搬家服务',
  }));
  const draft: RecommendationDraft = {
    title: '广州搬家如何核对服务',
    summary: '不同搬迁条件下的企业服务与预约核对。',
    opening: '广州搬家需要核对进场条件。步梯房和巷道容易增加搬运难度。',
    opening_heading: '大件进场有哪些难点',
    recommendation_heading: '两家搬迁服务如何选择',
    recommendations: context.companies.map((company, index) => ({
      company_id: company.id,
      text: '提供搬家服务，具体车辆能否抵达以及进场时间需要结合实际地址沟通核对。',
      citation_ids: [citations[index]!.citation_id],
      card_heading: '搬迁条件核对',
      card_sentence_indexes: [0],
    })),
    checklist: '①核对书面报价。②核对防护措施。③确认预约时间。',
    closing: '准备物品清单后，通过页面联系方式咨询。',
    topics: ['广州搬家', '搬家服务', '搬家报价'],
    cover_body: '楼道条件不同，如何核对书面报价？',
    pain_heading: '楼道转角核对',
    pain_body: '核对大件尺寸和楼道转角，确认能否通过再预约车辆。',
    checklist_heading: '书面报价核对',
    checklist_body: '将楼层、拆装和超距搬运项目写入报价单，逐项核对服务条件。',
    summary_heading: '预约前做确认',
    summary_body: '结合物品清单、楼层和车辆停靠条件询价，确认防护方式和预约时间，再安排进场。',
    faq: [
      { question: '如何询价？', answer: '提供物品清单。' },
      { question: '如何预约？', answer: '确认进场时间。' },
      { question: '如何核对？', answer: '查看书面报价。' },
    ],
  };
  return { context, citations, draft };
}

describe('multi-company recommendation mapping', () => {
  it('uses a functional checklist-card heading without changing its fee and package facts', () => {
    const { draft } = fixture();
    const { recommendations, ...fields } = draft;
    const cards = { ...fields, recommendations };
    const result = applyRecommendationHeadings(
      cards,
      { headings: [{ card_key: 'checklist', heading: '拆装另收费需核对两项' }] },
      ['checklist'],
    );
    expect(result.checklist_heading).toBe('预约前确认事项');
    expect(result.checklist_body).toBe(cards.checklist_body);
    expect(result.recommendations).toEqual(cards.recommendations);
  });
  it('does not teach corporate movers with a household-package example', () => {
    const corporate = recommendationWritingExampleForTopic('广州办公室和仓库搬迁');
    expect(corporate).toContain('办公室搬迁');
    expect(corporate).not.toContain('厨房拆包');
    expect(corporate).toContain('甲只展开办公区标签与工位，乙只展开仓库清点与批次');
    expect(corporate).toContain('纯办公室文章');
    expect(corporate).not.toContain('甲展开标识、清点和批次，乙展开新址摆放');
    expect(recommendationWritingExampleForTopic('广州日式家庭搬迁')).toContain('厨房拆包');
    expect(recommendationWritingExampleForTopic('钢琴搬运')).toBe('');
  });
  it('preserves saved citations without attaching unused company sources during reconstruction', () => {
    const { context, draft, citations } = fixture();
    const content = recommendationContent(draft, context, citations);
    const snapshot = JSON.stringify(content);
    const fresh = citations;
    const restored = recommendationArticleFromContent(content, context, [
      ...fresh,
      { ...citations[0]!, citation_id: 'unused-certificate' },
      { citation_id: 'foreign', source_id: 'not-configured', quote_text: '无关资料' },
    ])!;
    expect(restored.recommendations.map((item) => item.citation_ids)).toEqual([
      [citations[0]!.citation_id],
      [citations[1]!.citation_id],
    ]);
    expect(restored.recommendations.map((item) => item.text)).toEqual(
      draft.recommendations.map((item) => item.text),
    );
    expect(restored.opening).toBe(draft.opening);
    expect(JSON.stringify(content)).toBe(snapshot);
    expect(
      recommendationArticleFromContent({ ...content, blocks: [] }, context, fresh),
    ).toBeUndefined();
  });
  it('preserves a leading company name used as a grammatical subject', () => {
    const { context, draft } = fixture();
    context.platform_code = 'official_site';
    draft.recommendations[0]!.text = `${context.companies[0]!.legal_name}承接办公室和仓库搬迁。箱件按部门标记。`;
    expect(normalizeRecommendationArticle(draft, context).recommendations[0]!.text).toBe(
      draft.recommendations[0]!.text,
    );
  });
  it('keeps an explicit subject in Douyin instead of duplicating or deleting its company name', () => {
    const { context, draft } = fixture();
    draft.recommendations[0]!.text = `${context.companies[0]!.legal_name}承接办公室搬迁。`;
    expect(normalizeRecommendationArticle(draft, context).recommendations[0]!.text).toBe(
      '该公司承接办公室搬迁。',
    );
  });
  it('rejects source-photo narration but allows the confirmed service without a photo', () => {
    const { draft } = fixture();
    draft.recommendations[0]!.text = '作业照片里箱件和柜体上贴有蓝色标签，就是用来区分部门的。';
    expect(recommendationProseIssues(draft).join()).toContain('company_1');
    draft.recommendations[0]!.text =
      '该公司承接企业搬迁，箱件和柜体按部门贴标签，到新址后按工位摆放。';
    expect(recommendationProseIssues(draft)).toEqual([]);
    draft.faq[0]!.answer = '临时增加物品时，与企业负责人确认清单，再联系搬迁方调整安排。';
    expect(recommendationProseIssues(draft)).toEqual([]);
    draft.recommendations[0]!.text = '旧空调回收不在此段展开，由后续回收公司介绍。';
    expect(recommendationProseIssues(draft).join()).toContain('company_1');
  });
  it('rejects an operational heading that never introduces the recommended companies', () => {
    const { draft } = fixture();
    draft.recommendation_heading = '搬迁与回收分开对接';
    expect(recommendationFrameDuplicateIssues(draft).join()).toContain('recommendation_heading');
    draft.recommendation_heading = '广州搬迁与旧家电回收公司推荐';
    expect(recommendationFrameDuplicateIssues(draft)).toEqual([]);
  });
  it('keeps supplementary recycling out of a relocation-only headline', () => {
    const { draft } = fixture();
    draft.title = '广州办公室搬迁与旧家电回收推荐';
    expect(recommendationFrameDuplicateIssues(draft, '广州办公室搬迁').join()).toContain(
      '第二主线',
    );
    expect(recommendationFrameDuplicateIssues(draft, '广州办公室搬迁与家电回收')).toEqual([]);
  });
  it('includes safe three-sentence card selections promised by the schema', () => {
    const { draft, context } = fixture();
    draft.recommendations[0]!.text = '提供家庭搬迁。家具零件单独收纳。部件包装后运到新址。';
    expect(recommendationCardOptions(draft, context)[0]!.allowed_sentence_indexes).toContainEqual([
      0, 1, 2,
    ]);
    draft.recommendations[0]!.text =
      '提供家庭搬迁。家具零件单独收纳。' + '按物品情况确认包装方案'.repeat(10) + '。';
    expect(
      recommendationCardOptions(draft, context)[0]!.allowed_sentence_indexes,
    ).not.toContainEqual([0, 1, 2]);
  });
  it('keeps package definitions out of the opening, without banning a package-selection question', () => {
    const { draft } = fixture();
    draft.opening = '半日式只把物品送到新家指定房间，全日式则连衣物入柜一起完成。';
    expect(recommendationFrameDuplicateIssues(draft).join()).toContain('提前解释');
    draft.opening = '半日式把东西放到指定房间，全日式多走一步，衣物入柜、厨房拆包摆放。';
    expect(recommendationFrameDuplicateIssues(draft).join()).toContain('提前解释');
    draft.opening = '半日式和全日式怎么选？搬进新居后，衣物和厨房物品的整理需求各不相同。';
    expect(recommendationFrameDuplicateIssues(draft)).toEqual([]);
    draft.opening =
      '广州日式家庭搬迁咨询时，容易遇到套餐内容不清、拆装是否另收费不明的情况。先分清半日式与全日式各包含哪些整理归位项目，再决定要不要把旧家电一并处理。';
    expect(recommendationFrameDuplicateIssues(draft)).toEqual([]);
  });
  it('rejects household catalogues in office recommendations without banning household articles', () => {
    const { draft } = fixture();
    draft.title = '广州办公室搬迁如何安排家具拆装';
    draft.recommendations[1]!.text = '承接家具拆装，覆盖床、衣柜、书柜、沙发和餐桌椅。';
    expect(recommendationProseIssues(draft).join()).toContain('company_2');
    draft.title = '广州仓库搬迁怎么选服务商';
    draft.faq[0]!.answer = '仓库办公区继续使用的床、衣柜、餐桌椅可一并委托拆装。';
    expect(recommendationProseIssues(draft).join()).toContain('company_2');
    expect(recommendationProseIssues(draft).join()).toContain('faq_1');
    draft.recommendations[1]!.text =
      '承接企业搬迁，包含办公室和仓库搬迁，也提供广州同城搬家、跨市搬家、家具拆装、日式搬家、收纳整理、钢琴搬运、设备搬迁和艺术品搬运等服务。';
    expect(recommendationProseIssues(draft).join()).toContain('company_2');
    draft.title = '广州日式家庭搬迁怎么选';
    expect(recommendationProseIssues(draft)).toEqual([]);
  });
  it('rejects a second full Japanese-package definition but keeps shared moving identity', () => {
    const { draft } = fixture();
    draft.title = '广州日式家庭搬迁怎么选';
    draft.recommendations[0]!.text =
      '承接日式家庭搬迁。半日式包含整理、收纳、搬迁、放到指定房间；全日式额外包含衣物入柜、厨房物品拆包摆放。';
    draft.recommendations[1]!.text =
      '同样承接日式家庭搬迁，半日式提供整理收纳和搬到指定房间，全日式还提供衣物入柜、厨房拆包摆放。家具部件单独标记和包装。';
    expect(recommendationProseIssues(draft).join()).toContain('再次完整解释');
    draft.recommendations[1]!.text =
      '该公司承接广州日式家庭搬迁。同样提供整理、收纳、搬迁、放到指定房间。全日式额外包含衣物入柜、厨房物品拆包摆放。家具或电器拆装另收费。';
    expect(recommendationProseIssues(draft).join()).toContain('再次完整解释');
    draft.recommendations[1]!.text =
      '同样承接日式家庭搬迁，家具部件单独标记和包装，家具拆装另收费。';
    expect(recommendationProseIssues(draft)).toEqual([]);
  });
  it('does not treat a search question about timing or acceptance as the moving service name', () => {
    const { draft } = fixture();
    for (const suffix of ['时间安排确认', '交接验收']) {
      draft.recommendations[1]!.text = `该公司可承接广州半日式搬家${suffix}。`;
      expect(recommendationProseIssues(draft).join()).toContain('咨询问题');
    }
    draft.recommendations[1]!.text = '该公司承接日式家庭搬迁，搬家时间安排结合物品情况确认。';
    expect(recommendationProseIssues(draft)).toEqual([]);
  });
  it('preserves company paragraphs during mixed frame and company edits', () => {
    const { context, draft } = fixture(3);
    const edited = structuredClone(draft);
    edited.opening = '新的开头';
    edited.recommendations.forEach((item) => {
      item.text = '被无关编辑截短的正文';
    });
    const result = preserveUnmentionedCompanySections(draft, edited, context, [
      'opening主语错误',
      'company_3重复',
      'checklist需要分行',
    ]);
    expect(result.opening).toBe('新的开头');
    expect(result.recommendations[0]).toEqual(draft.recommendations[0]);
    expect(result.recommendations[1]).toEqual(draft.recommendations[1]);
    expect(result.recommendations[2]).toEqual(edited.recommendations[2]);
    expect(preserveUnmentionedCompanySections(draft, edited, context, ['全文字数不足'])).toBe(
      edited,
    );
  });
  it('requires an existing short fee sentence on a body card, without inventing a notice', () => {
    const { context, draft } = fixture();
    expect(recommendationRequiredNotice(draft)).toBeUndefined();
    const sentence = '家具或电器拆装额外收费。';
    draft.recommendations[0]!.text += sentence;
    expect(recommendationRequiredNotice(draft)).toBe(sentence);
    const schema = recommendationCardSelectionSchema(context, sentence);
    expect(schema).toMatchObject({ properties: { checklist_body: { pattern: sentence } } });
  });
  it('rejects choosing a Japanese package by disassembly needs, but keeps a valid organizing choice', () => {
    const { draft } = fixture();
    draft.checklist_body =
      '半日式和全日式涉及家具或电器拆装时，拆装额外收费。再核对自己是否需要拆装服务，决定选半日式还是全日式。';
    expect(recommendationCardChoiceIssues(draft).join()).toContain('checklist_body');
    draft.checklist_body =
      '半日式和全日式涉及家具或电器拆装时，拆装额外收费。再核对自己是否需要衣物入柜、厨房物品拆包摆放，判断选半日式还是全日式。';
    expect(recommendationCardChoiceIssues(draft)).toEqual([]);
    draft.checklist_body = '问清是否需要拆装服务，再选择对应拆装项目。';
    expect(recommendationCardChoiceIssues(draft)).toEqual([]);
  });
  it('resolves the company referent when moving a fee notice to a standalone checklist', () => {
    const { context, draft } = fixture();
    draft.recommendations[0]!.text = '该公司涉及家具拆装时，拆装额外收费。';
    expect(recommendationRequiredNotice(draft)).toBeUndefined();
    expect(recommendationRequiredNotice(draft, context)).toBe(
      `${context.companies[0]!.legal_name}涉及家具拆装时，拆装额外收费。`,
    );
  });
  it('does not force opening and checklist padding to meet the whole-body length gate', () => {
    const { context } = fixture();
    context.platform_code = 'official_site';
    const fields = recommendationFrameSchema(context)['properties'] as Record<
      string,
      { minLength?: number }
    >;
    expect(fields['opening']!.minLength).toBe(1);
    expect(fields['checklist']!.minLength).toBe(1);
    expect(fields['recommendations']).toBeUndefined();
    for (const instruction of [
      recommendationFrameInstruction(context),
      recommendationInstruction(context),
    ]) {
      expect(instruction).toContain('正文约1100字');
      expect(instruction).toContain('仅为篇幅提示');
      expect(instruction).not.toContain('至少1300');
      expect(instruction).not.toContain('1400–1600');
    }
    context.platform_code = 'lieju';
    expect(recommendationInstruction(context)).toContain('至少600有效汉字');
    expect(recommendationFrameInstruction(context)).toContain('至少600有效汉字');
    context.platform_code = 'douyin';
    expect(recommendationInstruction(context)).toContain('420–900');
    expect(recommendationFrameInstruction(context)).toContain('420–900');
  });
  it('preserves core service identity while treating recycling as supporting content', () => {
    const { context } = fixture();
    expect(RECOMMENDATION_EVIDENCE_PLAN_INSTRUCTION).toContain('主服务事实必须实际入选');
    expect(RECOMMENDATION_COMPANY_INSTRUCTION).toContain(
      '不能为了避重把第二家搬家公司降格成拆装工种',
    );
    expect(recommendationFrameInstruction(context)).toContain('配置了回收企业不等于标题必须写回收');
    expect(recommendationFrameInstruction(context)).toContain('家庭主题不套用企业公共物资');
  });
  it('rejects verbatim repeated company detail but permits short scope and necessary fees', () => {
    const { draft } = fixture();
    const detail =
      '办公区的箱件和家具按部门与工位安排，仓库的货品按清点结果和批次安排，两边在新址各自归位。';
    for (const company of draft.recommendations) company.text = '承接办公室和仓库搬迁。' + detail;
    expect(recommendationProseIssues(draft).join('')).toContain('逐字重复详细说明');
    draft.recommendations[1]!.text = '承接办公室和仓库搬迁。家具拆装另收费。';
    expect(recommendationProseIssues(draft)).toEqual([]);
    for (const company of draft.recommendations)
      company.text = '企业搬迁服务包含按部门贴标签、新址按工位摆放、仓库库存清点、分批搬迁。';
    expect(recommendationProseIssues(draft)).toEqual([]);
    for (const company of draft.recommendations)
      company.text =
        '该公司承接广州日式家庭搬迁，提供搬前物品整理分类、打包防护、运输和搬入后按要求摆放归位。';
    expect(recommendationProseIssues(draft)).toEqual([]);
  });
  it.each([
    '负责人确认企业搬迁包含部门标签。',
    '仓库搬迁时，负责人确认可按库存清点、分批搬迁来安排。',
    '首页半日式搬家服务明确包含全程打包。',
    '该公司持有道路运输经营许可证，承接范围与证照主体一致。',
    '该公司持有质量管理体系认证证书，证照主体与公司名称一致。',
    '箱件和柜体上的蓝色标签就是部门标签。',
    '本篇适用物品为个人搬家时准备出售的二手家电。',
  ])('rejects internal source attribution in customer copy: %s', (text) => {
    const { draft } = fixture();
    draft.recommendations[0]!.text = text;
    expect(recommendationProseIssues(draft).join('')).toMatch(/来源说明|写作过程说明/u);
    draft.recommendations[0]!.text = '该公司承接家庭搬迁，包含整理收纳。';
    expect(recommendationProseIssues(draft)).toEqual([]);
  });
  it('does not exempt duplicated workflows merely because the sentence also mentions fees', () => {
    const { draft } = fixture();
    for (const company of draft.recommendations)
      company.text =
        '办公室搬迁涉及计划、物品装箱清点标识、运输和新址按需归位，费用与物品数量、距离及服务内容有关。';
    expect(recommendationProseIssues(draft).join()).toContain('逐字重复详细说明');
    draft.recommendations[1]!.text = draft.recommendations[1]!.text.replace(
      '涉及计划',
      '同样涉及计划',
    );
    expect(recommendationProseIssues(draft).join()).toContain('逐字重复详细说明');
  });
  it('rejects presenting editorial emphasis as a comparative company advantage', () => {
    const { draft } = fixture();
    draft.recommendations[1]!.text =
      '该公司承接日式家庭搬迁。和上一家相比，它更侧重预约时把物品清单和时间窗口一次说清。';
    expect(recommendationProseIssues(draft).join()).toContain('company_2把写作重点差异');
    draft.recommendations[1]!.text = '该公司承接日式家庭搬迁，可在预约时沟通物品清单和时间窗口。';
    expect(recommendationProseIssues(draft)).toEqual([]);
  });
  it('does not infer a half-day deadline from the half-Japanese service tier', () => {
    const { draft } = fixture();
    draft.recommendations[0]!.text =
      '半日式包含整理、收纳、搬迁、放到指定房间，适合希望半天内完成主要物品归位的家庭。';
    expect(recommendationProseIssues(draft).join()).toContain('半天工期');
    draft.recommendations[0]!.text = '半日式是服务档位，不等于半天完成。';
    expect(recommendationProseIssues(draft)).toEqual([]);
  });
  it('keeps editorial role language and recycling consultation out of the service description', () => {
    const { draft } = fixture();
    draft.recommendations[0]!.text = '库存清点是它在本篇需求下值得展开的一环。';
    expect(recommendationProseIssues(draft).join()).toContain('写作过程说明');
    draft.recommendations[0]!.text = '该公司承接旧家电的回收沟通。';
    expect(recommendationProseIssues(draft).join()).toContain('主营业务');
    draft.recommendations[0]!.text = '该公司主营家电回收，可联系沟通准备出售的旧家电。';
    draft.summary = '确认家具拆装费用、零件标记防护及旧家电回收沟通，按需联系公司。';
    expect(recommendationProseIssues(draft)).toEqual([]);
  });
  it('does not copy the recycling provider business catalogue into a family article', () => {
    const { draft } = fixture();
    draft.title = '广州日式家庭搬迁怎么选';
    draft.recommendations[0]!.text =
      '该公司主营家电回收，企业、仓库、办公室搬迁以及个人搬家准备出售的家电均可回收。';
    expect(recommendationProseIssues(draft).join()).toContain('回收目录');
    draft.recommendations[0]!.text = '该公司主营家电回收，家庭搬迁准备出售的旧空调可联系回收。';
    expect(recommendationProseIssues(draft)).toEqual([]);
  });
  it('keeps warehouse stock separate from office workstations including FAQ', () => {
    const { draft } = fixture();
    draft.title = '广州仓库搬迁怎么选';
    draft.recommendations[0]!.text = '仓库货品贴标签后运到新址按工位摆放。';
    expect(recommendationProseIssues(draft).join()).toContain('仓库场景');
    draft.recommendations[0]!.text = '仓库内办公区的箱件按部门贴标签，到新址按工位摆放。';
    expect(recommendationProseIssues(draft)).toEqual([]);
    draft.recommendations[0]!.text = '办公区箱件按部门贴标签。运到新址后按工位摆放。';
    expect(recommendationProseIssues(draft)).toEqual([]);
    draft.faq = [{ question: '货品如何归位？', answer: '仓库货品贴标签后按工位摆放。' }];
    expect(recommendationProseIssues(draft).join()).toContain('faq_1');
  });
  it('returns all defects in one company paragraph before spending the repair attempt', () => {
    const { draft } = fixture();
    draft.title = '广州日式搬家怎么选';
    draft.recommendations[0]!.text =
      '该公司主营家电回收。本篇搬迁中准备出售的旧家电，企业、仓库、办公室及个人都可沟通回收。';
    const issues = recommendationProseIssues(draft).join();
    expect(issues).toContain('回收目录');
    expect(issues).toContain('写作过程说明“本篇搬迁中准备出售');
  });
  it('does not reduce a full moving company to disassembly-only identity', () => {
    const { draft } = fixture();
    draft.recommendations[1]!.text = '该公司承接日式家庭搬迁中的家具拆装需求。';
    expect(recommendationProseIssues(draft).join()).toContain('只承接拆装');
    draft.recommendations[1]!.text = '该公司承接日式家庭搬迁，同次搬迁中可委托家具拆装。';
    expect(recommendationProseIssues(draft)).toEqual([]);
  });
  it('does not let one Japanese mover consume both details leaving the next as a fee reminder', () => {
    const { draft } = fixture();
    draft.title = '广州全日式搬家怎么选';
    draft.recommendations[0]!.text =
      '承接日式家庭搬迁，全日式包含衣物入柜、厨房物品拆包摆放。家具零件标记包装，到新家组装。';
    draft.recommendations[1]!.text = '承接日式家庭搬迁，家具拆装另收费，方案和费用可预约确认。';
    expect(recommendationProseIssues(draft).join()).toContain('却仅剩服务身份');
    draft.recommendations[0]!.text = '承接日式家庭搬迁，全日式包含衣物入柜、厨房物品拆包摆放。';
    draft.recommendations[1]!.text =
      '承接日式家庭搬迁，家具零件标记包装，到新家组装，家具拆装另收费。';
    expect(recommendationProseIssues(draft)).toEqual([]);
  });
  it('rejects assigning the same detailed workflow to both companies before writing', () => {
    const { context, citations } = fixture();
    const details =
      '家居拆装服务：根据家具结构和连接特点选择拆卸方法和工具，拆卸后对零件分袋收纳并逐一标记家具编号，将不同家具的部件分开包装以便新址组装。';
    const sources = citations.map((citation, i) => ({
      ...citation,
      quote_text: `${context.companies[i]!.legal_name}${details}半日式和全日式涉及家具或电器拆装时，拆装额外收费。`,
    }));
    const plan = {
      companies: context.companies.map((company, i) => ({
        company_id: company.id,
        focus: '家具拆装',
        facts: [{ citation_id: citations[i]!.citation_id, sentence_indexes: [0, 1] }],
      })),
    };
    expect(recommendationPlanOverlapIssues(plan, context, sources)).toHaveLength(1);
    plan.companies[0]!.facts[0]!.sentence_indexes = [1];
    expect(recommendationPlanOverlapIssues(plan, context, sources)).toEqual([]);
    expect(sources[0]!.quote_text).toContain(details);
  });
  it('allows both companies to cite the same core service scope without inventing differences', () => {
    const { context, citations } = fixture();
    const scope =
      '提供广州同城搬家、跨市搬家、企业搬迁、家具拆装等服务，另有日式搬家、收纳整理、钢琴搬运、设备搬迁和艺术品搬运等业务。';
    const sources = citations.map((citation, i) => ({
      ...citation,
      quote_text: context.companies[i]!.legal_name + scope,
    }));
    const plan = {
      companies: context.companies.map((company, i) => ({
        company_id: company.id,
        focus: '承接企业搬迁',
        facts: [{ citation_id: citations[i]!.citation_id, sentence_indexes: [0] }],
      })),
    };
    expect(recommendationPlanOverlapIssues(plan, context, sources)).toEqual([]);
    for (const company of plan.companies)
      company.focus = '承接日式家庭搬迁，完整说明半日式与全日式及拆装费用';
    expect(recommendationPlanOverlapIssues(plan, context, sources).join()).toContain(
      'focus完全相同',
    );
    plan.companies[1]!.focus = '承接日式家庭搬迁，展开家具部件防护';
    expect(recommendationPlanOverlapIssues(plan, context, sources)).toEqual([]);
    plan.companies[0]!.focus =
      '承接企业搬迁；本段展开部门标签对应新址工位、库存清点与分批，不复述日式套餐。';
    plan.companies[1]!.focus = '承接企业搬迁；本段展开装箱清点标识、新址按需归位，不复述库存分批。';
    expect(recommendationPlanOverlapIssues(plan, context, sources).join()).toContain(
      '都被安排展开标识与新址归位',
    );
    plan.companies[1]!.focus = '承接企业搬迁；本段展开库存清点与分批，不复述部门标签与工位归位。';
    expect(recommendationPlanOverlapIssues(plan, context, sources)).toEqual([]);
  });
  it('scopes company writing and prevents frame/selection stages from writing other fields', () => {
    const { context } = fixture();
    expect(recommendationCompanySchema(context, 1)).toMatchObject({
      properties: { company_id: { const: context.companies[1]!.id } },
    });
    const frame = recommendationFrameSchema(context);
    expect(frame['required']).not.toContain('recommendations');
    expect(frame['properties']).not.toHaveProperty('recommendations');
    const selection = recommendationCardSelectionSchema(context);
    expect(selection['properties']).not.toHaveProperty('pain_heading');
    expect(selection).not.toHaveProperty(
      'properties.recommendations.items.properties.card_heading',
    );
  });
  it('encodes each company’s allowed excerpt combinations in the selection schema', () => {
    const { context } = fixture();
    const options = context.companies.map((company) => ({
      company_id: company.id,
      allowed_sentence_indexes: [[0], [2, 3]],
    }));
    const schema = recommendationCardSelectionSchema(context, undefined, options);
    expect(schema).toHaveProperty(
      'properties.recommendations.items.oneOf',
      options.map((option) => ({
        properties: {
          company_id: { const: option.company_id },
          card_sentence_indexes: { enum: [[0], [2, 3]] },
        },
      })),
    );
  });
  it('extracts final card text before headline writing and changes only the requested headline', () => {
    const { draft } = fixture();
    draft.recommendations[0]!.text = '提供整理收纳服务。另一个没有选入卡片的套餐说明。';
    const snapshot = JSON.stringify(draft);
    const excerpts = recommendationCardExcerpts(draft, draft);
    expect(excerpts.find((card) => card.card_key === 'company_1')!.body).toBe('提供整理收纳服务。');
    const edited = applyRecommendationHeadings(
      draft,
      { headings: [{ card_key: 'company_1', heading: '整理收纳服务' }] },
      ['company_1'],
    );
    expect(edited.recommendations[1]).toEqual(draft.recommendations[1]);
    expect(edited.recommendations[0]!.card_sentence_indexes).toEqual([0]);
    expect(JSON.stringify(draft)).toBe(snapshot);
    expect(() =>
      applyRecommendationHeadings(
        draft,
        { headings: [{ card_key: 'company_2', heading: '整理收纳服务' }] },
        ['company_1'],
      ),
    ).toThrow('顺序');
    expect(() =>
      recommendationCardExcerpts(draft, {
        ...draft,
        recommendations: [{ ...draft.recommendations[0]!, card_sentence_indexes: [99] }],
      }),
    ).toThrow('序号');
  });
  it('reports long verbatim frame repetitions but permits a short extra-fee reminder and FAQ', () => {
    const { draft } = fixture();
    const explanation = '搬迁前按部门为箱件和柜体做好标识，搬到新办公室后按照事先约定的工位摆放。';
    draft.recommendations[0]!.text = explanation;
    draft.opening = explanation;
    expect(recommendationFrameDuplicateIssues(draft)[0]).toContain('opening');
    draft.opening = '家具拆装额外收费。';
    draft.closing = '家具拆装额外收费。';
    draft.faq[0]!.answer = explanation;
    expect(recommendationFrameDuplicateIssues(draft)).toEqual([]);
  });
  it('constrains planner citation IDs to the frozen accounts available sources', () => {
    const { context, citations } = fixture();
    const schema = recommendationEvidencePlanSchema(context, [
      ...citations,
      { citation_id: 'unconfigured', source_id: 'unconfigured-source', quote_text: '无关资料' },
    ]);
    expect(schema).toMatchObject({
      properties: {
        companies: {
          items: {
            properties: {
              facts: {
                items: {
                  properties: { citation_id: { enum: citations.map((item) => item.citation_id) } },
                },
              },
            },
          },
        },
      },
    });
  });
  it.each([2, 3, 6])(
    'allows a substantive lead paragraph without equal per-company quotas (%i companies)',
    (count) => {
      const { context, draft, citations } = fixture(count);
      expect(recommendationArticleSchema(context)).toMatchObject({
        properties: { recommendations: { items: { properties: { text: { maxLength: 400 } } } } },
      });
      draft.recommendations[0]!.text = '提供搬迁服务，按部门标记箱件。'.repeat(16);
      draft.recommendations[1]!.text = '提供搬迁服务，搬到新址后按工位摆放桌柜和箱件。';
      const content = recommendationContent(draft, context, citations);
      expect(content.blocks.find((block) => block.block_key === 'company_1')?.text).toBe(
        draft.recommendations[0]!.text,
      );
      expect(content.blocks.find((block) => block.block_key === 'company_2')?.text).toBe(
        draft.recommendations[1]!.text,
      );
    },
  );
  it('selects the later company core service and different detail without changing sources', () => {
    const { context, citations } = fixture();
    citations[0]!.quote_text =
      '半日式包含整理收纳并放到指定房间。全日式额外包含衣物入柜。拆装额外收费。';
    citations[1]!.quote_text =
      '承接日式家庭搬迁。全日式额外包含衣物入柜。家具拆装零件单独收纳标记。拆装额外收费。';
    const before = JSON.stringify(citations);
    const selected = selectRecommendationEvidence(
      {
        companies: context.companies.map((company, index) => ({
          company_id: company.id,
          focus: index ? '日式家庭搬迁，展开家具拆装和费用' : '解释套餐选择',
          facts: [
            {
              citation_id: citations[index]!.citation_id,
              sentence_indexes: index ? [0, 2, 3] : [0, 1, 2],
            },
          ],
        })),
      },
      context,
      citations,
    );
    expect(selected[1]!['quote_text']).toBe(
      '承接日式家庭搬迁。\n家具拆装零件单独收纳标记。\n拆装额外收费。',
    );
    expect(JSON.stringify(citations)).toBe(before);
    expect(RECOMMENDATION_EVIDENCE_PLAN_INSTRUCTION).toContain(
      '每家同类公司都必须选入自己的主服务范围事实',
    );
  });

  it('compares per-company sentence selections instead of merging shared service evidence', () => {
    const { context, citations } = fixture();
    const source = citations[0]!;
    source.quote_text =
      '承接企业搬迁。搬迁前按部门贴标签，对应办公室工位安排搬入新址后按工位摆放物品。家具拆卸后零件单独标记，部件使用气泡膜包裹进行防护并在新址重新组装。';
    context.companies[1]!.source_document_ids = [context.companies[0]!.source_document_ids[0]!];
    const plan = {
      companies: context.companies.map((company, index) => ({
        company_id: company.id,
        focus: index
          ? '承接企业搬迁；本段展开家具部件防护。'
          : '承接企业搬迁；本段展开部门标签与新址工位。',
        facts: [{ citation_id: source.citation_id, sentence_indexes: [0, index + 1] }],
      })),
    };
    expect(recommendationPlanOverlapIssues(plan, context, [source])).toEqual([]);
    for (const company of plan.companies) company.facts[0]!.sentence_indexes = [0, 1, 2];
    expect(recommendationPlanOverlapIssues(plan, context, [source]).join()).toContain(
      '同一组详细说明',
    );
  });
  it('keeps website paragraphs flexible and relies on the whole-content length gate', () => {
    const { context } = fixture(3);
    context.platform_code = 'official_site';
    expect(recommendationArticleSchema(context)).toMatchObject({
      properties: {
        opening: { minLength: 1 },
        checklist: { minLength: 1 },
        recommendations: { items: { properties: { text: { minLength: 1 } } } },
      },
    });
  });
  it('allows a complete short Douyin transition without opening padding', () => {
    const { context } = fixture(3);
    context.platform_code = 'douyin';
    expect(recommendationArticleSchema(context)).toMatchObject({
      properties: { opening: { minLength: 1, maxLength: 130 } },
    });
  });
  it('does not offer excerpts whose referent was left in another card', () => {
    const { context, draft } = fixture();
    draft.recommendations[0]!.text = '半日式与全日式的项目划分与上述一致。提供家具拆装服务。';
    const options = recommendationCardOptions(draft, context)[0]!.allowed_sentence_indexes;
    expect(options).toEqual([[1]]);
  });
  it('does not offer fee-only excerpts as company recommendation cards', () => {
    const { context, draft } = fixture(2);
    draft.recommendations[0]!.text =
      '该公司承接日式搬迁，半日式包含整理、收纳、搬运到指定房间。家具或电器拆装额外收费。';
    const option = recommendationCardOptions(draft, context)[0]!;
    expect(option.allowed_sentence_indexes).toContainEqual([0]);
    expect(option.allowed_sentence_indexes).not.toContainEqual([1]);
    draft.recommendations[0]!.text = '家具或电器拆装额外收费。费用按家具类型确定。';
    expect(recommendationCardOptions(draft, context)[0]!.allowed_sentence_indexes).toEqual([]);
  });
  it.each(['official_site', 'lieju', 'douyin'] as const)(
    'uses editorial emphasis rather than fabricated company differentiation on %s',
    (platform) => {
      const { context } = fixture();
      context.platform_code = platform;
      const instruction = recommendationInstruction(context);
      expect(instruction).toContain('共同主服务可简洁重复，详细流程不重复');
      expect(instruction).toContain('正文不主动说明共同经营');
      expect(instruction).toContain('官网FAQ保留实用问答');
      expect(instruction).toContain('不能写货品按工位摆放');
      expect(instruction).toContain('不要把家具类型、数量和拆装难度说成整场搬迁的计费依据');
      expect(instruction).not.toContain('每家挑选与本篇最相关的2–3项');
      expect(instruction).not.toContain('每家公司约');
    },
  );
  it('only selects exact same-company evidence and never invents a source excerpt', () => {
    const { context, citations } = fixture();
    const plan = {
      companies: context.companies.map((company, index) => ({
        company_id: company.id,
        focus: '搬迁',
        facts: [
          {
            citation_id: citations[index]!.citation_id,
            sentence_indexes: [0],
          },
        ],
      })),
    };
    expect(selectRecommendationEvidence(plan, context, citations)).toHaveLength(2);
    plan.companies[0]!.facts[0]!.sentence_indexes = [99];
    expect(() => selectRecommendationEvidence(plan, context, citations)).toThrow('有效句子');
    plan.companies[0]!.facts[0] = { citation_id: citations[1]!.citation_id, sentence_indexes: [0] };
    expect(() => selectRecommendationEvidence(plan, context, citations)).toThrow('该公司');
  });
  it('removes only a duplicated leading company label and offers length-safe card choices', () => {
    const { context, draft } = fixture(3);
    draft.recommendations[0]!.text = `${context.companies[0]!.legal_name}：提供搬家服务。具体通道和物品情况可在预约时说明。`;
    const article = normalizeRecommendationArticle(draft, context);
    expect(article.recommendations[0]!.text).toBe(
      '提供搬家服务。具体通道和物品情况可在预约时说明。',
    );
    for (const [index, option] of recommendationCardOptions(article, context).entries()) {
      for (const indexes of option.allowed_sentence_indexes) {
        const count = [
          ...`${context.companies[index]!.legal_name}：${indexes.map((i) => option.sentences[i]).join('\n')}`,
        ].length;
        expect(count).toBeGreaterThanOrEqual(24);
        expect(count).toBeLessThanOrEqual(88);
      }
    }
  });
  it.each(['official_site', 'lieju', 'douyin'] as const)(
    'maps a configured recycling company to its own evidence without changing its business on %s',
    (platform) => {
      const { context, citations, draft } = fixture(3);
      context.platform_code = platform;
      context.companies[2]!.legal_name = '广州盛源机电制冷工程有限公司';
      citations[2]!.quote_text = '主营家电回收，对接搬迁时准备出售的二手空调和家电。';
      const recycler = draft.recommendations[2]!;
      recycler.text = '主营家电回收，可对接搬迁时准备出售的二手空调和家电。';
      recycler.card_heading = '不再搬走的旧家电';
      draft.recommendation_heading = '搬迁与旧家电回收服务';
      const content = recommendationContent(draft, context, citations);
      expect(assessCompanyRecommendation(content, context)).toEqual([]);
      expect(content.blocks.find((block) => block.block_key === 'company_3')?.text).toBe(
        recycler.text,
      );
      expect(content.citation_map[2]?.citation_ids).toEqual([citations[2]!.citation_id]);
      if (platform === 'douyin') {
        const cards = content.platform_meta['cards'] as { card_key: string; body: string }[];
        expect(cards).toHaveLength(7);
        expect(cards.find((card) => card.card_key === 'company_3')?.body).toBe(
          `广州盛源机电制冷工程有限公司：${recycler.text}`,
        );
      }
      recycler.citation_ids = [citations[0]!.citation_id];
      expect(() => recommendationContent(draft, context, citations)).toThrow('引用未绑定');
      const withoutRecycler = { ...context, companies: context.companies.slice(0, 2) };
      expect(() => recommendationContent(draft, withoutRecycler, citations)).toThrow('名单数量');
    },
  );
  it('keeps related-business and package rules generic instead of globally adding a company or tariff', () => {
    const { context } = fixture();
    const prompt = recommendationInstruction(context);
    expect(prompt).toContain('不能把名单中的所有企业都写成搬家公司');
    expect(prompt).toContain('未配置的企业不得因背景资料提及而加入正文、卡片或FAQ');
    expect(prompt).toContain('套餐定义、收费方式写成整个行业的统一做法');
    expect(prompt).not.toContain('广州盛源机电制冷工程有限公司');
    expect(prompt).not.toContain('全日式包含衣物入柜');
  });
  it('preserves unaffected companies and citations during a company-scoped repair', () => {
    const { context, citations, draft } = fixture();
    const previous = recommendationContent(draft, context, citations);
    const changed = {
      ...draft,
      title: '不应更换标题',
      opening_heading: '不应修改的开篇',
      pain_body: '不应修改痛点卡',
      summary_body: '不应修改总结卡',
      recommendations: draft.recommendations.map((item) => ({
        ...item,
        text: '修改后的服务说明',
        card_sentence_indexes: [0],
      })),
    };
    const repaired = preserveUnaffectedRecommendationCompanies(changed, previous, context, [
      'company_1 引用需要修复',
    ]);
    expect(repaired.title).toBe(draft.title);
    expect(repaired.opening_heading).toBe(draft.opening_heading);
    expect(repaired.pain_body).toBe(draft.pain_body);
    expect(repaired.summary_body).toBe(draft.summary_body);
    expect(repaired.recommendations[0]?.text).toBe('修改后的服务说明');
    expect(repaired.recommendations[1]).toEqual(draft.recommendations[1]);
    expect(
      preserveUnaffectedRecommendationCompanies(changed, previous, context, ['全文字数不足']),
    ).toBe(changed);
    expect(
      preserveUnaffectedRecommendationCompanies(changed, previous, context, [
        'company_1 引用需要修复',
        '全文字数不足',
      ]),
    ).toBe(changed);
  });
  it('keeps a repaired frame when its reported duplication mentions a company', () => {
    const { context, citations, draft } = fixture();
    const previous = recommendationContent(draft, context, citations);
    const edited = { ...draft, opening: '修复后的开头', closing: '修复后的结尾' };
    const openingIndex = previous.blocks.findIndex((block) => block.block_key === 'opening');
    for (const location of ['blocks.opening.text', `blocks[${openingIndex}].text`, 'closing']) {
      expect(
        preserveUnaffectedRecommendationCompanies(edited, previous, context, [
          `位置：${location}；与company_1段落的套餐解释重复，应删去重复`,
          'company_1 证照位置需要调整',
        ]),
      ).toBe(edited);
    }
  });
  it.each([2, 3, 4, 5, 6])(
    'preserves the ordered %i-company list and produces 6–9 cards',
    (count) => {
      const { context, citations, draft } = fixture(count);
      const content = recommendationContent(draft, context, citations);
      expect(
        content.blocks
          .filter((block) => /company_\d+_heading/u.test(block.block_key))
          .map((block) => block.text),
      ).toEqual(context.companies.map((company) => company.legal_name));
      expect(content.platform_meta['cards']).toHaveLength(count <= 4 ? count + 4 : count + 3);
      expect(assessCompanyRecommendation(content, context)).toEqual([]);
      expect(
        assessDouyinOwnerPromotion(content, [context.companies[0]!.legal_name], context),
      ).toEqual([]);
      expect(content.citation_map[0]?.citation_ids).toEqual([citations[0]!.citation_id]);
    },
  );
  it('rejects another company’s citation, reordered names and card facts not in the body', () => {
    const { context, citations, draft } = fixture();
    expect(() =>
      recommendationContent(
        { ...draft, recommendations: [draft.recommendations[1]!, draft.recommendations[0]!] },
        context,
        citations,
      ),
    ).toThrow('顺序');
    draft.recommendations[0]!.citation_ids = [citations[1]!.citation_id];
    expect(() => recommendationContent(draft, context, citations)).toThrow('引用');
    draft.recommendations[0]!.citation_ids = [citations[0]!.citation_id];
    draft.recommendations[0]!.card_sentence_indexes = [99];
    expect(() => recommendationContent(draft, context, citations)).toThrow('句子序号');
  });
  it('does not apply promotional structure to legacy or excluded platforms', () => {
    expect(assessCompanyRecommendation({}, null)).toEqual([]);
    const { context, citations, draft } = fixture();
    const content = recommendationContent(draft, context, citations);
    const legacy = {
      ...content,
      platform_meta: {
        ...content.platform_meta,
        description: `${context.companies[0]!.legal_name}。\n\n通用说明。`,
      },
    };
    expect(assessDouyinOwnerPromotion(legacy, [context.companies[0]!.legal_name])).not.toEqual([]);
  });
  it('uses topical headings and reserves the company-name space in card budgets', () => {
    const { context, citations, draft } = fixture();
    const content = recommendationContent(draft, context, citations);
    expect(content.blocks[0]?.text).toBe(draft.opening_heading);
    expect(content.blocks[2]?.text).toBe(draft.recommendation_heading);
    const prompt = recommendationInstruction(context);
    expect(recommendationCardInstruction(context)).toContain(
      `所选句子合计最多 ${88 - [...context.companies[0]!.legal_name].length - 1} 字`,
    );
    expect(prompt).toContain('两家公司服务相近可以如实相近');
  });
  it('separates article fields from cards and rejects cross-company card assembly', () => {
    const { context, draft } = fixture();
    const properties = recommendationArticleSchema(context)['properties'] as Record<
      string,
      unknown
    >;
    expect(properties['pain_body']).toBeUndefined();
    expect(properties['faq']).toMatchObject({ maxItems: 0 });
    const assembled = assembleRecommendationDraft(draft);
    expect(assembled.recommendations[0]?.text).toBe(draft.recommendations[0]?.text);
    expect(() =>
      assembleRecommendationDraft(draft, {
        ...draft,
        recommendations: [...draft.recommendations].reverse(),
      }),
    ).toThrow('顺序');
  });
  it('allows complete selected sentences but rejects new or decontextualized card facts after editing', () => {
    const { context, citations, draft } = fixture();
    const item = draft.recommendations[0]!;
    item.text = '提供家具拆装服务。拆装费用按家具数量沟通。对拆卸零件单独收纳并标记。';
    item.card_sentence_indexes = [0, 2];
    const content = recommendationContent(draft, context, citations);
    expect(assessCompanyRecommendation(content, context)).toEqual([]);
    const cards = content.platform_meta['cards'] as { card_key: string; body: string }[];
    expect(cards.find((card) => card.card_key === 'company_1')!.body).toBe(
      `${context.companies[0]!.legal_name}：提供家具拆装服务。\n对拆卸零件单独收纳并标记。`,
    );
    cards.find((card) => card.card_key === 'company_1')!.body =
      `${context.companies[0]!.legal_name}：提供持证吊装服务。`;
    expect(assessCompanyRecommendation(content, context).join()).toContain('卡片事实');
    expect(isRecommendationCardExcerpt('不提供家电专业安装服务。', '提供家电专业安装服务。')).toBe(
      false,
    );
    expect(isRecommendationCardExcerpt('如另行预约，可提供清理服务。', '可提供清理服务。')).toBe(
      false,
    );
    expect(
      isRecommendationCardExcerpt(item.text, '对拆卸零件单独收纳并标记。提供家具拆装服务。'),
    ).toBe(false);
    expect(isRecommendationCardExcerpt(item.text, '')).toBe(false);
  });
  it.each([[1, 0], [0, 0], [-1], [0.5], [], [0, 1, 2, 3]])(
    'rejects invalid card sentence selection %j',
    (...indexes) => {
      const { context, citations, draft } = fixture();
      draft.recommendations[0]!.card_sentence_indexes = indexes;
      expect(() => recommendationContent(draft, context, citations)).toThrow('句子序号');
    },
  );
  it('checks the full legal-name card budget without silently cutting sentences', () => {
    const { context, citations, draft } = fixture();
    draft.recommendations[0]!.text = '保留完整条件和否定'.repeat(12) + '。';
    expect(() => recommendationContent(draft, context, citations)).toThrow('须24–88字');
    const schema = recommendationDraftSchema(context);
    expect((schema['properties'] as Record<string, unknown>)['cover_body']).toEqual({
      type: 'string',
      minLength: 12,
      maxLength: 46,
    });
  });
});
