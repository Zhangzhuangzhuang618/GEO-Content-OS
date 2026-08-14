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
});

async function fixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL('./fixtures/lieju.valid.input.json', import.meta.url), 'utf8'),
  ) as unknown;
}
