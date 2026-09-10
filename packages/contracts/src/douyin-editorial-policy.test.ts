import { describe, expect, it } from 'vitest';

import {
  assessDouyinImageNoteEditorial,
  assessDouyinOwnerPromotion,
} from './douyin-editorial-policy.js';

describe('Douyin editorial policy', () => {
  it.each([
    ['涉及家具或电器拆装时，拆装额外收费。', true],
    ['家具拆装费用另计。', true],
    ['家具拆装需另行收费。', true],
    ['搬运之外的拆装单独收费。', true],
    ['家具拆装费用需要沟通确认。', false],
    ['提供家具拆装服务，按需求咨询。', false],
  ])('recognizes an explicit extra-fee service boundary: %s', (body, accepted) => {
    const content = validContent();
    for (const card of content.platform_meta.cards.slice(1, -1)) {
      card.heading = '具体服务安排';
      card.body = `预约前核对物品清单并选择所需服务内容。${body}`;
    }
    expect(assessDouyinImageNoteEditorial(content).some((item) => item.code === 'card_risk')).toBe(
      !accepted,
    );
  });
  it('accepts a complete narrative image note', () => {
    expect(assessDouyinImageNoteEditorial(validContent())).toEqual([]);
  });
  it.each([
    '广州全日式搬家交接验收，重点看物品是否按房间归位。',
    '广州日式搬迁先核验套餐与拆装收费条件',
    '广州半日式搬家签合同前，先弄清半日式包不包打包、家具拆装是否另收费。',
    '广州半日式搬家包含哪些打包归位项目',
    '广州全日式搬家交接验收，先弄清半日式与全日式项目差别，再确认拆装另收费。',
    '广州搬迁能否按新址工位归位',
  ])('recognizes a concrete cover question without requiring a question mark: %s', (body) => {
    const content = validContent();
    content.platform_meta.cards[0]!.heading = '广州搬迁服务';
    content.platform_meta.cards[0]!.body = body;
    expect(assessDouyinImageNoteEditorial(content).map((item) => item.code)).not.toContain(
      'cover_hook',
    );
    content.platform_meta.cards[0]!.body = '提供搬运和整理服务，欢迎咨询预约。';
    expect(assessDouyinImageNoteEditorial(content).map((item) => item.code)).toContain(
      'cover_hook',
    );
  });
  it.each([
    '列出需要服务方处理的整理工作，明确选半日式还是全日式。',
    '按衣物、厨房归位需求选半日式或全日式。',
    '想省掉搬后逐件整理，就要先分清半日式和全日式。',
    '预约前对比基础搬运与入柜整理的服务范围。',
  ])('recognizes an explicit service choice: %s', (choice) => {
    const content = validContent();
    for (const card of content.platform_meta.cards.slice(1, -1)) {
      card.heading = '整理服务范围';
      card.body = `搬家前把物品列清楚。${choice}`;
    }
    expect(assessDouyinImageNoteEditorial(content).map((item) => item.code)).not.toContain(
      'card_selection',
    );
    for (const card of content.platform_meta.cards.slice(1, -1))
      card.body = '提供家庭物品搬运服务，广州本地均可咨询具体安排，欢迎了解。';
    expect(assessDouyinImageNoteEditorial(content).map((item) => item.code)).toContain(
      'card_selection',
    );
  });

  it('enforces the 20-character creator-center image-note title limit', () => {
    const content = validContent();
    content.title = '搬'.repeat(20);
    expect(assessDouyinImageNoteEditorial(content).map((finding) => finding.code)).not.toContain(
      'title_length',
    );

    content.title = '搬'.repeat(21);
    expect(assessDouyinImageNoteEditorial(content).map((finding) => finding.code)).toContain(
      'title_length',
    );
  });

  it('reports the same editorial blockers for a short manual edit', () => {
    const content = validContent();
    content.platform_meta.description = '搬家前先核对现场。';
    content.platform_meta.cards = [];
    expect(assessDouyinImageNoteEditorial(content).map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['cards_count', 'description_length']),
    );
  });

  it('checks the actual description and topic text written to the creator center', () => {
    const content = validContent();
    content.platform_meta.description = '搬'.repeat(900);
    content.platform_meta.topics = Array.from(
      { length: 8 },
      (_, index) => `${index + 1}${'搬'.repeat(39)}`,
    );
    expect(assessDouyinImageNoteEditorial(content).map((finding) => finding.code)).toContain(
      'caption_length',
    );
  });

  it('requires the owner in a solution paragraph without allowing repeated promotion', () => {
    const owner = '广州志远搬家服务有限公司';
    const content = validContent();
    expect(assessDouyinOwnerPromotion(content, [owner]).map((finding) => finding.code)).toEqual([
      'owner_solution_mention',
    ]);

    content.platform_meta.description = content.platform_meta.description.replace(
      '确定方案前应核对',
      `${owner}在确定方案前可协助核对`,
    );
    expect(assessDouyinOwnerPromotion(content, [owner])).toEqual([]);

    content.platform_meta.description += `\n\n${owner}提醒核对清单，${owner}可继续说明服务边界。`;
    expect(assessDouyinOwnerPromotion(content, [owner]).map((finding) => finding.code)).toEqual([
      'owner_mention_limit',
    ]);
  });

  it('requires visible mapped evidence before the title promises a real scene', () => {
    const content = validContent();
    content.title = '广州搬家真实场景记录';

    expect(assessDouyinImageNoteEditorial(content).map((finding) => finding.code)).toContain(
      'title_evidence_promise',
    );

    const claimText = '现场记录显示两端均需核对楼层和电梯条件';
    content.platform_meta.description = content.platform_meta.description.replace(
      '确定方案前应核对',
      `${claimText}；确定方案前应核对`,
    );
    content.citation_map = [
      {
        citation_ids: ['81000000-0000-4000-8000-000000000001'],
        claim_key: 'scene-evidence',
        claim_text: claimText,
      },
    ];

    expect(assessDouyinImageNoteEditorial(content).map((finding) => finding.code)).not.toContain(
      'title_evidence_promise',
    );
  });

  it('accepts concrete customer consequences as card risk information', () => {
    const content = validContent();
    content.platform_meta.cards = content.platform_meta.cards.map((card) => ({
      ...card,
      body: card.body.replace(/风险|避免|不要|不适合|注意|否则|边界|不能|可能|警惕/gu, '').trim(),
    }));
    content.platform_meta.cards[3]!.body =
      '停车距离和临时拆装没有写进报价，车辆到场后容易加价，预算会被打乱。';

    expect(assessDouyinImageNoteEditorial(content).map((finding) => finding.code)).not.toContain(
      'card_risk',
    );
  });

  it('accepts a social-style circled-number checklist', () => {
    const content = validContent();
    content.platform_meta.description = content.platform_meta.description.replace(
      /第一，.+?；第二，.+?；第三，.+?；第四，.+?。/u,
      '手机里记四项：①拍下大件；②发清楼层；③逐项问报价；④留好书面约定。',
    );

    expect(assessDouyinImageNoteEditorial(content).map((finding) => finding.code)).not.toContain(
      'description_tips',
    );
  });
});

function validContent() {
  return {
    blocks: [{ block_key: 'intro', block_type: 'paragraph', text: '正文说明现场核对方法。' }],
    citation_map: [] as Array<{
      citation_ids: string[];
      claim_key: string;
      claim_text: string;
    }>,
    platform_meta: {
      cards: [
        {
          body: '跨区搬家别急着定车，先把现场条件和时间限制排清楚。',
          card_key: 'cover',
          heading: '跨区搬家当天怎么排',
          kind: 'cover',
        },
        {
          body: '旧址楼层、电梯预约、门口停车位置，都会影响装卸顺序和等待时间。',
          card_key: 'scenario',
          heading: '先看两边现场条件',
          kind: 'body',
        },
        {
          body: '根据物品体积和道路条件选择车型，同时核对车辆能否进入两端装卸点。',
          card_key: 'criteria',
          heading: '车型要按条件判断',
          kind: 'body',
        },
        {
          body: '先分房间清点物品；再标记大件和易碎品；最后确认拆装与复位顺序。',
          card_key: 'steps',
          heading: '物品按三步准备',
          kind: 'body',
        },
        {
          body: '注意临时加项、超时等待和无法停车等风险，不能只比较一个打包总价。',
          card_key: 'risk',
          heading: '这些临时风险要确认',
          kind: 'body',
        },
        {
          body: '按现场条件选车型，按清单准备物品，并把时间、费用和异常处理逐项确认。',
          card_key: 'summary',
          heading: '最后按清单再核对',
          kind: 'summary',
        },
      ],
      content_kind: 'image_note',
      description: NARRATIVE_DESCRIPTION,
      topics: ['跨区搬家', '搬家准备', '搬家避坑', '广州搬家'],
    },
    summary: '提供跨区搬家的现场核对、报价、防护和时间安排方法。',
    title: '一份搬家服务选择指南',
  };
}

const NARRATIVE_DESCRIPTION = [
  '一份搬家服务选择指南。广州跨区搬家涉及两端楼层、电梯预约、停车位置和物品拆装，任一条件遗漏都容易带来等待、临时加项或物品磕碰。',
  '确定方案前应核对新旧地址的通道、门洞、装卸距离和可作业时间，记录大件、易碎品与需要拆装的家具。现场信息越完整，车型、人员和搬运顺序越容易评估，也能减少到场后反复调整。',
  '报价环节要把运输、人工、拆装、包装、楼层和等待等项目分别确认，并写清哪些情况会增加费用。只拿一个总价比较，很难判断服务范围是否一致；把服务边界落在书面约定里，后续核对更直接。',
  '物品防护与责任处理也要提前谈清。易碎品可按类别包装，大件家具需要确认拆装方式，贵重或特殊物品应单独记录；交接时按清单验收，发现磕碰或缺件便于按约定处理。',
  '预约时间会影响车辆调度和整体工期。遇到电梯限时、园区进场登记或道路临停限制，应预留沟通时间，并确认计划变化时的响应方式，避免人员和车辆到场后长时间等待。',
  '实操可按四点核对：第一，比较两到三份服务方案，确认项目口径一致；第二，把易碎品、大件和特殊物品单独列出；第三，确认电梯、停车和进场时间；第四，把费用变化条件、责任划分和验收方式写进约定。',
  '搬家方案需要结合物品规模、两端现场和时间要求综合判断。对照现场记录、分项报价、防护安排与异常处理方式逐项选择，能够减少临时变更带来的风险。',
].join('\n\n');
