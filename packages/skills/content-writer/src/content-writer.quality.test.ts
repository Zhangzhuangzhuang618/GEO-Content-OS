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
        'douyin:platform_meta.cards 必须包含 5–10 张图文卡片',
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
        body: '先明确搬家需求和现场条件。',
        card_key: 'cover',
        heading: '搬家前怎么准备',
        kind: 'cover',
      },
      {
        body: '列出物品、楼层和车辆通行条件。',
        card_key: 'inventory',
        heading: '先列清单',
        kind: 'body',
      },
      {
        body: '核对服务范围、计价方式和额外费用。',
        card_key: 'quote',
        heading: '确认报价',
        kind: 'body',
      },
      {
        body: '把时间、责任边界和异常处理写进约定。',
        card_key: 'terms',
        heading: '书面确认',
        kind: 'body',
      },
      {
        body: '按清单逐项验收并保存双方确认记录。',
        card_key: 'summary',
        heading: '最后复核',
        kind: 'summary',
      },
    ],
    content_kind: 'image_note',
    description: '搬家前可执行的准备、报价与验收清单。',
    topics: ['搬家准备', '搬家指南'],
  } as const;
}

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
