import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { renderToutiao } from './src/render.js';
import { TOUTIAO_RENDER_RULES_V1 } from './src/rules.js';
import { TOUTIAO_PAYLOAD_JSON_SCHEMA, TOUTIAO_RENDER_INPUT_JSON_SCHEMA } from './src/schema.js';
import { validateToutiaoContent } from './src/validate.js';

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe('toutiao render contract', () => {
  it('publishes immutable versioned rules and Draft 2020-12 schemas', async () => {
    expect(TOUTIAO_RENDER_RULES_V1.version).toBe('toutiao-render-rules@1.0.0');
    expect(Object.isFrozen(TOUTIAO_RENDER_RULES_V1)).toBe(true);
    expect(Object.isFrozen(TOUTIAO_RENDER_RULES_V1.clickbaitTitleMarkers)).toBe(true);
    expect(TOUTIAO_RENDER_INPUT_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(TOUTIAO_PAYLOAD_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );

    const input = await readJson('toutiao.valid.input.json');
    const inputValidator = validator(TOUTIAO_RENDER_INPUT_JSON_SCHEMA);
    expect(
      inputValidator(input),
      inputValidator.errors?.map((error) => error.message).join('; '),
    ).toBe(true);
  });

  it('matches the deterministic valid golden fixture', async () => {
    const input = await readJson('toutiao.valid.input.json');
    const golden = (await readJson('toutiao.valid.golden.json')) as ValidGolden;
    const result = renderToutiao(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payloadValidator = validator(TOUTIAO_PAYLOAD_JSON_SCHEMA);
    expect(
      payloadValidator(result.payload),
      payloadValidator.errors?.map((error) => error.message).join('; '),
    ).toBe(true);
    expect(result.payload).toMatchObject({
      content_type: golden.content_type,
      platform_code: golden.platform_code,
      rule_version: golden.rule_version,
      schema_version: golden.schema_version,
    });
    expect(result.payload.tags).toHaveLength(golden.tag_count);
    expect(result.payload.citation_links).toHaveLength(golden.citation_link_count);
    expect(sha256(result.payload)).toBe(golden.payload_sha256);
  });

  it('matches the blocker golden fixture and never renders invalid content', async () => {
    const input = await readJson('toutiao.invalid.input.json');
    const golden = (await readJson('toutiao.invalid.golden.json')) as {
      readonly blocker_codes: readonly string[];
    };
    const validation = validateToutiaoContent(input);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.map((issue) => issue.code).sort()).toEqual(golden.blocker_codes);
    expect(validation.issues.every((issue) => issue.severity === 'blocker')).toBe(true);
    expect(renderToutiao(input)).toEqual(validation);
  });

  it('blocks over-length titles instead of truncating them', async () => {
    const input = (await readJson('toutiao.valid.input.json')) as {
      content: { title: string };
    };
    input.content.title = '超'.repeat(51);

    const result = renderToutiao(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('TITLE_LENGTH_OUT_OF_RANGE');
  });

  it('requires an answer block after the question', async () => {
    const input = (await readJson('toutiao.valid.input.json')) as {
      content: { blocks: unknown[] };
    };
    input.content.blocks = input.content.blocks.slice(0, 1);

    const result = validateToutiaoContent(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('QUESTION_ANSWER_REQUIRED');
  });

  it('requires a source for time-sensitive claims', async () => {
    const input = (await readJson('toutiao.valid.input.json')) as {
      content: { citation_map: unknown[] };
    };
    input.content.citation_map = [];

    const result = validateToutiaoContent(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('TIME_SENSITIVE_CITATION_REQUIRED');
  });

  it('does not use an unrelated citation to satisfy a time-sensitive claim', async () => {
    const input = (await readJson('toutiao.valid.input.json')) as {
      content: { citation_map: { claim_text: string }[] };
    };
    input.content.citation_map[0]!.claim_text = '可信资料需要保留来源。';

    const result = validateToutiaoContent(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('TIME_SENSITIVE_CITATION_REQUIRED');
  });

  it('blocks referenced citations that have no output link', async () => {
    const input = (await readJson('toutiao.valid.input.json')) as { citations: unknown[] };
    input.citations = [];

    const result = renderToutiao(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('CITATION_LINK_MISSING');
  });

  it('escapes untrusted text while preserving validated citation links', async () => {
    const input = (await readJson('toutiao.valid.input.json')) as {
      content: { blocks: { text: string }[] };
    };
    input.content.blocks[1]!.text += '<script>alert("x")</script>';

    const result = renderToutiao(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.body_html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(result.payload.body_html).not.toContain('<script>alert');
    expect(result.payload.body_html).toContain('rel="noopener noreferrer"');
  });

  it('rejects unknown input fields before applying platform rules', async () => {
    const input = (await readJson('toutiao.valid.input.json')) as Record<string, unknown>;
    input['unexpected'] = true;
    const result = validateToutiaoContent(input);
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
  readonly rule_version: string;
  readonly schema_version: string;
  readonly tag_count: number;
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
