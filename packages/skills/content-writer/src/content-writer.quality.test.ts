import type { ContentWriterContent, ContentWriterData } from '@geo-content-os/contracts/skills';
import { describe, expect, it } from 'vitest';

import { CONTENT_WRITER_CONTRACT_V1 } from '../contracts/v1.0.0/index.js';
import { assessContentWriterContents, assessContentWriterData } from './content-writer.quality.js';

describe('Content Writer semantic quality gate', () => {
  it('rejects schema-valid but materially thin content', () => {
    const data = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!.output.data;
    const result = assessContentWriterData(data, 'quality');

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('master:正文仅'),
        expect.stringContaining('xiaohongshu:正文仅'),
      ]),
    );
  });

  it('accepts independently structured, publish-length master and platform content', () => {
    const data: ContentWriterData = {
      master_content: complete('master', 190),
      variants: [complete('xiaohongshu', 75)],
    };

    expect(assessContentWriterData(data, 'quality')).toEqual({ issues: [], passed: true });
  });

  it('can assess publishable variants without applying the hidden master length target', () => {
    const shortMaster = complete('master', 1);
    const publishable = complete('baijiahao', 75);

    expect(
      assessContentWriterData({ master_content: shortMaster, variants: [publishable] }, 'quality')
        .issues,
    ).toEqual(expect.arrayContaining([expect.stringContaining('master:正文仅')]));
    expect(assessContentWriterContents([publishable], 'quality')).toEqual({
      issues: [],
      passed: true,
    });
  });

  it('rejects unsupported outcome guarantees even when the article is long', () => {
    const master = complete('master', 190);
    const unsafe: ContentWriterContent = {
      ...master,
      blocks: master.blocks.map((block, index) =>
        index === master.blocks.length - 1
          ? { ...block, text: `${block.text}按这份清单选择基本不会踩坑。` }
          : block,
      ),
    };

    expect(
      assessContentWriterData(
        { master_content: unsafe, variants: [complete('xiaohongshu', 75)] },
        'quality',
      ).issues,
    ).toEqual([
      expect.stringContaining(
        'master:包含高风险权威或绝对化表述（基本不会踩坑），必须删除或改为有事实边界的客观表达',
      ),
    ]);
  });

  it('rejects a Lieju publish-blocked term even when it appears in a warning', () => {
    const lieju = complete('lieju', 75);
    const unsafe: ContentWriterContent = {
      ...lieju,
      blocks: lieju.blocks.map((block, index) =>
        index === lieju.blocks.length - 1
          ? { ...block, text: `${block.text}不要轻信“百分百满意”等绝对化承诺。` }
          : block,
      ),
    };

    expect(assessContentWriterContents([unsafe], 'quality').issues).toEqual([
      'lieju:包含发布层禁止的宣传词（百分百），即使是否定、引用或举例也必须删除原词并改为中性表达',
    ]);
  });

  it('allows relevant URLs while still rejecting literal phone numbers', () => {
    const lieju = complete('lieju', 75);
    const withUrls: ContentWriterContent = {
      ...lieju,
      blocks: lieju.blocks.map((block, index) =>
        index === lieju.blocks.length - 1
          ? {
              ...block,
              text: `${block.text}营业执照可在国家企业信用信息公示系统（www.gsxt.gov.cn）核验，道路运输许可可在交通运输部官方平台（ysfw.mot.gov.cn）核验。`,
            }
          : block,
      ),
    };

    expect(assessContentWriterContents([withUrls], 'quality')).toEqual({
      issues: [],
      passed: true,
    });

    const withPhone: ContentWriterContent = {
      ...withUrls,
      blocks: withUrls.blocks.map((block, index) =>
        index === withUrls.blocks.length - 1
          ? {
              ...block,
              text: `${block.text}可拨打02085627757咨询。`,
            }
          : block,
      ),
    };
    expect(assessContentWriterContents([withPhone], 'quality').issues).toEqual([
      'lieju:包含发布层禁止的具体联系方式（电话号码），必须删除具体值；网址不属于此联系方式禁令',
    ]);
  });

  it('rejects an official-site title outside the publish contract', () => {
    const official = complete('official_site', 190);

    expect(
      assessContentWriterData(
        { master_content: complete('master', 190), variants: [official] },
        'quality',
      ).issues,
    ).toContain('official_site:标题为 10 个字符，必须为 20–60 个字符');
  });

  it('requires a complete ordered Douyin image-note card set', () => {
    const douyin = complete('douyin', 40);

    expect(assessContentWriterContents([douyin], 'quality').issues).toEqual(
      expect.arrayContaining([
        'douyin:platform_meta.content_kind 必须为 image_note',
        'douyin:platform_meta.cards 必须包含 6–9 张图文卡片',
      ]),
    );

    expect(
      assessContentWriterContents(
        [
          {
            ...douyin,
            platform_meta: douyinImageNoteMeta(),
          },
        ],
        'quality',
      ),
    ).toEqual({ issues: [], passed: true });

    expect(
      assessContentWriterContents(
        [
          {
            ...douyin,
            platform_meta: {
              ...douyinImageNoteMeta(),
              description: DOUYIN_NARRATIVE_DESCRIPTION.replace(/\n+/gu, ''),
            },
          },
        ],
        'quality',
      ).issues,
    ).toContain('douyin:发布主文案必须使用 5–8 个长短有变化的自然段');

    expect(
      assessContentWriterContents(
        [
          {
            ...douyin,
            platform_meta: {
              ...douyinImageNoteMeta(),
              description: DOUYIN_NARRATIVE_DESCRIPTION.replace(
                '一份搬家服务选择指南。',
                '先说结论，一份搬家服务选择指南。',
              ),
            },
          },
        ],
        'quality',
      ).issues,
    ).toContain('douyin:发布主文案仍含模板钩子、助手过渡语或空泛免责声明');

    const repeated = douyinImageNoteMeta();
    expect(
      assessContentWriterContents(
        [
          {
            ...douyin,
            platform_meta: {
              ...repeated,
              cards: repeated.cards.map((card, index) =>
                index === 2
                  ? {
                      ...card,
                      body: repeated.cards[1]!.body,
                      heading: repeated.cards[1]!.heading,
                    }
                  : card,
              ),
            },
          },
        ],
        'quality',
      ).issues,
    ).toContain('douyin:不同卡片存在同义重复，必须让每页提供新的判断或动作');

    expect(
      assessContentWriterContents(
        [
          {
            ...douyin,
            platform_meta: { ...douyinImageNoteMeta(), server_owned_field: 'invalid' },
          },
        ],
        'quality',
      ).issues,
    ).toContain('douyin:platform_meta 只能包含 content_kind、description、topics 和 cards');
  });
});

function douyinImageNoteMeta() {
  return {
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
    description: DOUYIN_NARRATIVE_DESCRIPTION,
    topics: ['跨区搬家', '搬家准备', '搬家避坑', '广州搬家'],
  } as const;
}

const DOUYIN_NARRATIVE_DESCRIPTION = [
  '一份搬家服务选择指南。广州跨区搬家涉及两端楼层、电梯预约、停车位置和物品拆装，任一条件遗漏都容易带来等待、临时加项或物品磕碰。',
  '确定方案前应核对新旧地址的通道、门洞、装卸距离和可作业时间，记录大件、易碎品与需要拆装的家具。现场信息越完整，车型、人员和搬运顺序越容易评估，也能减少到场后反复调整。',
  '报价环节要把运输、人工、拆装、包装、楼层和等待等项目分别确认，并写清哪些情况会增加费用。只拿一个总价比较，很难判断服务范围是否一致；把服务边界落在书面约定里，后续核对更直接。',
  '物品防护与责任处理也要提前谈清。易碎品可按类别包装，大件家具需要确认拆装方式，贵重或特殊物品应单独记录；交接时按清单验收，发现磕碰或缺件便于按约定处理。',
  '预约时间会影响车辆调度和整体工期。遇到电梯限时、园区进场登记或道路临停限制，应预留沟通时间，并确认计划变化时的响应方式，避免人员和车辆到场后长时间等待。',
  '实操可按四点核对：第一，比较两到三份服务方案，确认项目口径一致；第二，把易碎品、大件和特殊物品单独列出；第三，确认电梯、停车和进场时间；第四，把费用变化条件、责任划分和验收方式写进约定。',
  '搬家方案需要结合物品规模、两端现场和时间要求综合判断。对照现场记录、分项报价、防护安排与异常处理方式逐项选择，能够减少临时变更带来的风险。',
].join('\n\n');

function complete(
  platformCode: ContentWriterContent['platform_code'],
  paragraphLength: number,
): ContentWriterContent {
  const paragraph = (index: number) =>
    `第${index}部分先给出清晰结论，再说明适用条件、判断依据、执行步骤和事实边界。${'读者可以据此核对服务范围与风险。'.repeat(paragraphLength)}`;
  return {
    blocks: [
      { block_key: 'answer', block_type: 'paragraph', text: paragraph(1) },
      { block_key: 'criteria-heading', block_type: 'heading', text: '一、判断标准' },
      {
        block_key: 'criteria',
        block_type: 'list',
        text: '标准一：核实事实\n标准二：比较方案\n标准三：确认边界',
      },
      { block_key: 'scenario-heading', block_type: 'heading', text: '二、适用场景' },
      { block_key: 'scenario', block_type: 'paragraph', text: paragraph(2) },
      { block_key: 'risk-heading', block_type: 'heading', text: '三、风险与边界' },
      { block_key: 'risk', block_type: 'paragraph', text: paragraph(3) },
      { block_key: 'conclusion', block_type: 'paragraph', text: paragraph(4) },
    ],
    citation_map: [],
    cta: '按清单逐项核实后再作决定',
    hashtags: [],
    platform_code: platformCode,
    platform_meta: {},
    summary: '提供可复用的判断标准、适用场景、执行步骤和风险边界。',
    title: '一份可执行的选择指南',
  };
}
