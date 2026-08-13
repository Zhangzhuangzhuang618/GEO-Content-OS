import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { renderSohu } from './src/render.js';
import { SOHU_RENDER_RULES_V1 } from './src/rules.js';
import { SohuPayloadSchema } from './src/schema.js';
import { validateSohuContent } from './src/validate.js';

describe('Sohu render contract', () => {
  it('renders a deterministic non-original AI-declared article', async () => {
    const input = await fixture();
    const first = renderSohu(input);
    const second = renderSohu(input);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(SohuPayloadSchema.safeParse(first.payload).success).toBe(true);
    expect(first.payload).toMatchObject({
      ai_generated: true,
      original: false,
      platform_code: 'sohu',
      rule_version: 'sohu-render-rules@1.0.0',
      schema_version: 'sohu-payload@1',
    });
    expect(first.payload.body_html).not.toContain('href=');
  });

  it('freezes the title, summary and structure gates', () => {
    expect(SOHU_RENDER_RULES_V1).toMatchObject({
      abstract: { maximumCharacters: 120, minimumCharacters: 1 },
      aiGenerated: true,
      original: false,
      requiredBodySegments: 5,
      title: { maximumCharacters: 72, minimumCharacters: 5 },
    });
    expect(Object.isFrozen(SOHU_RENDER_RULES_V1)).toBe(true);
  });

  it('blocks an over-length title instead of truncating it', async () => {
    const input = (await fixture()) as { content: { title: string } };
    input.content.title = '超'.repeat(73);
    const result = validateSohuContent(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('PAYLOAD_SCHEMA_INVALID');
  });
});

async function fixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL('./fixtures/sohu.valid.input.json', import.meta.url), 'utf8'),
  ) as unknown;
}
