import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { renderLieju } from './src/render.js';
import { LIEJU_RENDER_RULES_V1 } from './src/rules.js';
import { LiejuPayloadSchema } from './src/schema.js';
import { validateLiejuContent } from './src/validate.js';

describe('Lieju render contract', () => {
  it('renders a deterministic classified-information payload', async () => {
    const input = await fixture();
    const first = renderLieju(input);
    const second = renderLieju(input);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(LiejuPayloadSchema.safeParse(first.payload).success).toBe(true);
    expect(first.payload).toMatchObject({
      content_type: 'logistics_freight',
      platform_code: 'lieju',
      rule_version: 'lieju-render-rules@1.0.0',
      schema_version: 'lieju-payload@1',
    });
    expect(first.payload.body_text).not.toMatch(/https?:\/\/|1[3-9]\d{9}/u);
  });

  it('freezes the title, summary and structure gates', () => {
    expect(LIEJU_RENDER_RULES_V1).toMatchObject({
      body: { maximumCharacters: 8_000, minimumCharacters: 600 },
      requiredBodySegments: 5,
      title: { maximumCharacters: 30, minimumCharacters: 5 },
    });
    expect(Object.isFrozen(LIEJU_RENDER_RULES_V1)).toBe(true);
  });

  it('blocks an over-length title instead of truncating it', async () => {
    const input = (await fixture()) as { content: { title: string } };
    input.content.title = '超'.repeat(31);
    const result = validateLiejuContent(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('PAYLOAD_SCHEMA_INVALID');
  });

  it('allows first-party evidence wording without treating it as a ranking claim', async () => {
    const input = (await fixture()) as { content: { blocks: Array<{ text: string }> } };
    input.content.blocks[0]!.text += '该车辆信息属于企业第一方确认信息。';

    const result = validateLiejuContent(input);

    expect(result.ok).toBe(true);
  });

  it('allows ordinary ordinal wording without treating it as a ranking claim', async () => {
    const input = (await fixture()) as { content: { blocks: Array<{ text: string }> } };
    input.content.blocks[0]!.text +=
      '第一步先盘点物品，第一阶段核对清单，第一时间记录异常，第一年资料按合同留存。';

    const result = validateLiejuContent(input);

    expect(result.ok).toBe(true);
  });

  it.each(['广州行业第一', '本地排名第一', '第一品牌', '自称第一。'])(
    'continues to block explicit first-place promotional claim: %s',
    async (claim) => {
      const input = (await fixture()) as { content: { blocks: Array<{ text: string }> } };
      input.content.blocks[0]!.text += `本公司${claim}`;

      const result = validateLiejuContent(input);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.code)).toContain('PROHIBITED_TERM');
    },
  );

  it('continues to block a prohibited term inside a quoted negative example', async () => {
    const input = (await fixture()) as { content: { blocks: Array<{ text: string }> } };
    input.content.blocks[0]!.text += '不要轻信“百分百满意”等绝对化承诺。';

    const result = validateLiejuContent(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('PROHIBITED_TERM');
  });

  it('blocks bare domains in verification guidance', async () => {
    const input = (await fixture()) as { content: { blocks: Array<{ text: string }> } };
    input.content.blocks[0]!.text +=
      '营业执照可在国家企业信用信息公示系统（www.gsxt.gov.cn）核验，道路运输许可可在交通运输部官方平台（ysfw.mot.gov.cn）核验。';

    const result = validateLiejuContent(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('CONTACT_INFO_FORBIDDEN');
  });
});

async function fixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL('./fixtures/lieju.valid.input.json', import.meta.url), 'utf8'),
  ) as unknown;
}
