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

  it('rejects an official-site title outside the publish contract', () => {
    const official = complete('official_site', 190);

    expect(
      assessContentWriterData(
        { master_content: complete('master', 190), variants: [official] },
        'quality',
      ).issues,
    ).toContain('official_site:标题为 10 个字符，必须为 20–60 个字符');
  });
});

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
