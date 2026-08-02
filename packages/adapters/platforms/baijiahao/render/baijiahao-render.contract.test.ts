import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { renderBaijiahao } from './src/render.js';
import { BAIJIAHAO_RENDER_RULES_V1 } from './src/rules.js';
import { BAIJIAHAO_PAYLOAD_JSON_SCHEMA, BAIJIAHAO_RENDER_INPUT_JSON_SCHEMA } from './src/schema.js';
import { validateBaijiahaoContent } from './src/validate.js';

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe('baijiahao render contract', () => {
  it('publishes immutable versioned rules and Draft 2020-12 schemas', async () => {
    expect(BAIJIAHAO_RENDER_RULES_V1.version).toBe('baijiahao-render-rules@1.1.0');
    expect(Object.isFrozen(BAIJIAHAO_RENDER_RULES_V1)).toBe(true);
    expect(Object.isFrozen(BAIJIAHAO_RENDER_RULES_V1.tags)).toBe(true);
    expect(BAIJIAHAO_RENDER_INPUT_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(BAIJIAHAO_PAYLOAD_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );

    const input = await readJson('baijiahao.valid.input.json');
    const inputValidator = validator(BAIJIAHAO_RENDER_INPUT_JSON_SCHEMA);
    expect(
      inputValidator(input),
      inputValidator.errors?.map((error) => error.message).join('; '),
    ).toBe(true);
  });

  it('matches the deterministic valid golden fixture', async () => {
    const input = await readJson('baijiahao.valid.input.json');
    const golden = (await readJson('baijiahao.valid.golden.json')) as ValidGolden;
    const result = renderBaijiahao(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payloadValidator = validator(BAIJIAHAO_PAYLOAD_JSON_SCHEMA);
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
    const input = await readJson('baijiahao.invalid.input.json');
    const golden = (await readJson('baijiahao.invalid.golden.json')) as {
      readonly blocker_codes: readonly string[];
    };
    const validation = validateBaijiahaoContent(input);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.map((issue) => issue.code).sort()).toEqual(golden.blocker_codes);
    expect(validation.issues.every((issue) => issue.severity === 'blocker')).toBe(true);
    expect(renderBaijiahao(input)).toEqual(validation);
  });

  it('blocks over-length titles instead of truncating them', async () => {
    const input = (await readJson('baijiahao.valid.input.json')) as {
      content: { title: string };
    };
    input.content.title = '超'.repeat(41);

    const result = renderBaijiahao(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('TITLE_LENGTH_OUT_OF_RANGE');
  });

  it('accepts relative time only when the same segment gives an absolute date', async () => {
    const input = (await readJson('baijiahao.valid.input.json')) as {
      content: { blocks: { text: string }[] };
    };
    input.content.blocks[0]!.text += '近日（2026年7月15日）完成规则复核。';

    expect(validateBaijiahaoContent(input).ok).toBe(true);
  });

  it('escapes untrusted text without exposing third-party citation links', async () => {
    const input = (await readJson('baijiahao.valid.input.json')) as {
      content: { blocks: { text: string }[] };
    };
    input.content.blocks[0]!.text += '<script>alert("x")</script>';

    const result = renderBaijiahao(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.body_html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(result.payload.body_html).not.toContain('<script>alert');
    expect(result.payload.body_html).not.toContain('href=');
    expect(result.payload.citation_links).toEqual([]);
  });

  it('keeps citation provenance server-side even when public links are absent', async () => {
    const input = (await readJson('baijiahao.valid.input.json')) as {
      citations: unknown[];
    };
    input.citations = [];

    const result = renderBaijiahao(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.citation_links).toEqual([]);
    expect(result.payload.body_html).not.toContain('href=');
  });

  it('rejects unknown input fields before applying platform rules', async () => {
    const input = (await readJson('baijiahao.valid.input.json')) as Record<string, unknown>;
    input['unexpected'] = true;
    const result = validateBaijiahaoContent(input);
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
