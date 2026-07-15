import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { renderXiaohongshu } from './src/render.js';
import { XIAOHONGSHU_RENDER_RULES_V1 } from './src/rules.js';
import {
  XIAOHONGSHU_PAYLOAD_JSON_SCHEMA,
  XIAOHONGSHU_RENDER_INPUT_JSON_SCHEMA,
} from './src/schema.js';
import { validateXiaohongshuContent } from './src/validate.js';

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe('xiaohongshu render contract', () => {
  it('publishes immutable versioned rules and Draft 2020-12 schemas', async () => {
    expect(XIAOHONGSHU_RENDER_RULES_V1.version).toBe('xiaohongshu-render-rules@1.0.0');
    expect(Object.isFrozen(XIAOHONGSHU_RENDER_RULES_V1)).toBe(true);
    expect(Object.isFrozen(XIAOHONGSHU_RENDER_RULES_V1.experienceClaimMarkers)).toBe(true);
    expect(XIAOHONGSHU_RENDER_INPUT_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(XIAOHONGSHU_PAYLOAD_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    const input = await readJson('xiaohongshu.valid.input.json');
    const inputValidator = validator(XIAOHONGSHU_RENDER_INPUT_JSON_SCHEMA);
    expect(inputValidator(input), errors(inputValidator.errors)).toBe(true);
  });

  it('matches the deterministic valid golden fixture', async () => {
    const input = await readJson('xiaohongshu.valid.input.json');
    const golden = (await readJson('xiaohongshu.valid.golden.json')) as ValidGolden;
    const result = renderXiaohongshu(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payloadValidator = validator(XIAOHONGSHU_PAYLOAD_JSON_SCHEMA);
    expect(payloadValidator(result.payload), errors(payloadValidator.errors)).toBe(true);
    expect(result.payload).toMatchObject({
      note_type: golden.note_type,
      platform_code: golden.platform_code,
      rule_version: golden.rule_version,
      schema_version: golden.schema_version,
    });
    expect(result.payload.topics).toHaveLength(golden.topic_count);
    expect(result.payload.citation_links).toHaveLength(golden.citation_link_count);
    expect(sha256(result.payload)).toBe(golden.payload_sha256);
  });

  it('matches blocker golden and never renders invalid content', async () => {
    const input = await readJson('xiaohongshu.invalid.input.json');
    const golden = (await readJson('xiaohongshu.invalid.golden.json')) as {
      blocker_codes: string[];
    };
    const validation = validateXiaohongshuContent(input);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.map((issue) => issue.code).sort()).toEqual(golden.blocker_codes);
    expect(renderXiaohongshu(input)).toEqual(validation);
  });

  it('blocks title over 20 characters instead of truncating it', async () => {
    const input = (await readJson('xiaohongshu.valid.input.json')) as {
      content: { title: string };
    };
    input.content.title = '超'.repeat(21);
    expect(codes(validateXiaohongshuContent(input))).toContain('TITLE_LENGTH_OUT_OF_RANGE');
  });

  it('requires at least one non-empty list block', async () => {
    const input = (await readJson('xiaohongshu.valid.input.json')) as {
      content: { blocks: { block_type: string }[] };
    };
    input.content.blocks[1]!.block_type = 'paragraph';
    expect(codes(validateXiaohongshuContent(input))).toContain('LIST_BLOCK_REQUIRED');
  });

  it('blocks unverified first-person experience claims', async () => {
    const input = (await readJson('xiaohongshu.valid.input.json')) as {
      content: { summary: string };
    };
    input.content.summary = '我亲测这套方法一定有效。';
    expect(codes(validateXiaohongshuContent(input))).toContain('UNVERIFIED_EXPERIENCE_CLAIM');
  });

  it('blocks referenced citations without output links', async () => {
    const input = (await readJson('xiaohongshu.valid.input.json')) as { citations: unknown[] };
    input.citations = [];
    expect(codes(validateXiaohongshuContent(input))).toContain('CITATION_LINK_MISSING');
  });

  it('escapes untrusted text and preserves safe citation links', async () => {
    const input = (await readJson('xiaohongshu.valid.input.json')) as {
      content: { blocks: { text: string }[] };
    };
    input.content.blocks[2]!.text += '<script>alert("x")</script>';
    const result = renderXiaohongshu(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.body_html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(result.payload.body_html).not.toContain('<script>alert');
    expect(result.payload.body_html).toContain('rel="noopener noreferrer"');
  });

  it('rejects unknown input fields before platform rules', async () => {
    const input = (await readJson('xiaohongshu.valid.input.json')) as Record<string, unknown>;
    input['unexpected'] = true;
    expect(codes(validateXiaohongshuContent(input))).toEqual(['PAYLOAD_SCHEMA_INVALID']);
  });
});

interface ValidGolden {
  citation_link_count: number;
  note_type: string;
  payload_sha256: string;
  platform_code: string;
  rule_version: string;
  schema_version: string;
  topic_count: number;
}

function validator(schema: object) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const addFormats = addFormatsImport as unknown as FormatsPlugin;
  addFormats(ajv);
  return ajv.compile(schema);
}

function errors(value: readonly { message?: string }[] | null | undefined): string {
  return value?.map((error) => error.message).join('; ') ?? '';
}

function codes(result: ReturnType<typeof validateXiaohongshuContent>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

async function readJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl(name), 'utf8')) as unknown;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
