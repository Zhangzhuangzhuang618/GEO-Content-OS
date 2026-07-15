import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { renderZhihu } from './src/render.js';
import { ZHIHU_RENDER_RULES_V1 } from './src/rules.js';
import { ZHIHU_PAYLOAD_JSON_SCHEMA, ZHIHU_RENDER_INPUT_JSON_SCHEMA } from './src/schema.js';
import { validateZhihuContent } from './src/validate.js';

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe('zhihu render contract', () => {
  it('publishes immutable versioned rules and Draft 2020-12 schemas', async () => {
    expect(ZHIHU_RENDER_RULES_V1.version).toBe('zhihu-render-rules@1.0.0');
    expect(Object.isFrozen(ZHIHU_RENDER_RULES_V1)).toBe(true);
    expect(Object.isFrozen(ZHIHU_RENDER_RULES_V1.boundaryMarkers)).toBe(true);
    expect(Object.isFrozen(ZHIHU_RENDER_RULES_V1.marketingMarkers)).toBe(true);
    expect(ZHIHU_RENDER_INPUT_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(ZHIHU_PAYLOAD_JSON_SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');

    const input = await readJson('zhihu.valid.input.json');
    const inputValidator = validator(ZHIHU_RENDER_INPUT_JSON_SCHEMA);
    expect(
      inputValidator(input),
      inputValidator.errors?.map((error) => error.message).join('; '),
    ).toBe(true);
  });

  it('matches the deterministic valid golden fixture', async () => {
    const input = await readJson('zhihu.valid.input.json');
    const golden = (await readJson('zhihu.valid.golden.json')) as ValidGolden;
    const result = renderZhihu(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payloadValidator = validator(ZHIHU_PAYLOAD_JSON_SCHEMA);
    expect(
      payloadValidator(result.payload),
      payloadValidator.errors?.map((error) => error.message).join('; '),
    ).toBe(true);
    expect(result.payload).toMatchObject({
      content_type: golden.content_type,
      platform_code: golden.platform_code,
      question_id: golden.question_id,
      rule_version: golden.rule_version,
      schema_version: golden.schema_version,
    });
    expect(result.payload.topics).toHaveLength(golden.topic_count);
    expect(result.payload.citation_links).toHaveLength(golden.citation_link_count);
    expect(sha256(result.payload)).toBe(golden.payload_sha256);
  });

  it('matches the blocker golden fixture and never renders invalid content', async () => {
    const input = await readJson('zhihu.invalid.input.json');
    const golden = (await readJson('zhihu.invalid.golden.json')) as {
      readonly blocker_codes: readonly string[];
    };
    const validation = validateZhihuContent(input);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.map((issue) => issue.code).sort()).toEqual(golden.blocker_codes);
    expect(validation.issues.every((issue) => issue.severity === 'blocker')).toBe(true);
    expect(renderZhihu(input)).toEqual(validation);
  });

  it('requires the first block to directly answer instead of asking another question', async () => {
    const input = (await readJson('zhihu.valid.input.json')) as {
      content: { blocks: { block_type: string; text: string }[] };
    };
    input.content.blocks[0] = {
      ...input.content.blocks[0]!,
      block_type: 'paragraph',
      text: '企业真的需要可信证据链吗？',
    };

    const result = validateZhihuContent(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('DIRECT_ANSWER_REQUIRED');
  });

  it('requires an explicit boundary, limitation, exception or counterexample', async () => {
    const input = (await readJson('zhihu.valid.input.json')) as {
      content: { blocks: { text: string }[] };
    };
    for (const block of input.content.blocks) {
      block.text = block.text
        .replaceAll('边界', '条件')
        .replaceAll('限制', '条件')
        .replaceAll('反例', '案例');
    }

    const result = validateZhihuContent(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain(
      'BOUNDARY_OR_COUNTEREXAMPLE_REQUIRED',
    );
  });

  it('blocks referenced citations that have no output link', async () => {
    const input = (await readJson('zhihu.valid.input.json')) as { citations: unknown[] };
    input.citations = [];

    const result = renderZhihu(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('CITATION_LINK_MISSING');
  });

  it('blocks marketing superlatives in body content', async () => {
    const input = (await readJson('zhihu.valid.input.json')) as {
      content: { blocks: { text: string }[] };
    };
    input.content.blocks[2]!.text += '这是行业第一的完美解决方案。';

    const result = validateZhihuContent(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('MARKETING_TONE_FORBIDDEN');
  });

  it('escapes untrusted text while preserving validated citation links', async () => {
    const input = (await readJson('zhihu.valid.input.json')) as {
      content: { blocks: { text: string }[] };
    };
    input.content.blocks[2]!.text += '<script>alert("x")</script>';

    const result = renderZhihu(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.body_html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(result.payload.body_html).not.toContain('<script>alert');
    expect(result.payload.body_html).toContain('rel="noopener noreferrer"');
  });

  it('rejects unknown input fields before applying platform rules', async () => {
    const input = (await readJson('zhihu.valid.input.json')) as Record<string, unknown>;
    input['unexpected'] = true;
    const result = validateZhihuContent(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(['PAYLOAD_SCHEMA_INVALID']);
  });
});

interface ValidGolden {
  readonly citation_link_count: number;
  readonly content_type: string;
  readonly payload_sha256: string;
  readonly platform_code: string;
  readonly question_id: string;
  readonly rule_version: string;
  readonly schema_version: string;
  readonly topic_count: number;
}

function validator(schema: object) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const addFormats = addFormatsImport as unknown as FormatsPlugin;
  addFormats(ajv);
  return ajv.compile(schema);
}

async function readJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl(name), 'utf8')) as unknown;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
