import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { renderWechatMp } from './src/render.js';
import { WECHAT_MP_RENDER_RULES_V1 } from './src/rules.js';
import { WECHAT_MP_PAYLOAD_JSON_SCHEMA, WECHAT_MP_RENDER_INPUT_JSON_SCHEMA } from './src/schema.js';
import { validateWechatMpContent } from './src/validate.js';

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe('wechat mp render contract', () => {
  it('publishes immutable versioned rules and Draft 2020-12 schemas', async () => {
    expect(WECHAT_MP_RENDER_RULES_V1.version).toBe('wechat-mp-render-rules@1.0.0');
    expect(Object.isFrozen(WECHAT_MP_RENDER_RULES_V1)).toBe(true);
    expect(Object.isFrozen(WECHAT_MP_RENDER_RULES_V1.requiredPlatformMeta)).toBe(true);
    expect(WECHAT_MP_RENDER_INPUT_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(WECHAT_MP_PAYLOAD_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    const input = await readJson('wechat_mp.valid.input.json');
    const inputValidator = validator(WECHAT_MP_RENDER_INPUT_JSON_SCHEMA);
    expect(inputValidator(input), errors(inputValidator.errors)).toBe(true);
  });

  it('matches the deterministic valid golden fixture', async () => {
    const input = await readJson('wechat_mp.valid.input.json');
    const golden = (await readJson('wechat_mp.valid.golden.json')) as ValidGolden;
    const result = renderWechatMp(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payloadValidator = validator(WECHAT_MP_PAYLOAD_JSON_SCHEMA);
    expect(payloadValidator(result.payload), errors(payloadValidator.errors)).toBe(true);
    expect(result.payload).toMatchObject({
      author: golden.author,
      platform_code: golden.platform_code,
      rule_version: golden.rule_version,
      schema_version: golden.schema_version,
    });
    expect(result.payload.internal_links).toHaveLength(golden.internal_link_count);
    expect(result.payload.citation_links).toHaveLength(golden.citation_link_count);
    expect(sha256(result.payload)).toBe(golden.payload_sha256);
  });

  it('matches blocker golden and never renders invalid content', async () => {
    const input = await readJson('wechat_mp.invalid.input.json');
    const golden = (await readJson('wechat_mp.invalid.golden.json')) as {
      blocker_codes: string[];
    };
    const validation = validateWechatMpContent(input);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.map((issue) => issue.code).sort()).toEqual(golden.blocker_codes);
    expect(renderWechatMp(input)).toEqual(validation);
  });

  it('blocks titles over 64 characters instead of truncating them', async () => {
    const input = (await readJson('wechat_mp.valid.input.json')) as {
      content: { title: string };
    };
    input.content.title = '超'.repeat(65);
    expect(codes(validateWechatMpContent(input))).toContain('TITLE_LENGTH_OUT_OF_RANGE');
  });

  it('requires digest, a leading paragraph, an internal link and a CTA', async () => {
    const input = (await readJson('wechat_mp.valid.input.json')) as {
      content: {
        blocks: { block_type: string; text: string }[];
        cta: string | null;
        platform_meta: { digest: string };
      };
      internal_links: unknown[];
    };
    input.content.platform_meta.digest = ' ';
    input.content.blocks[0]!.block_type = 'heading';
    input.content.blocks[0]!.text = '标题';
    input.content.cta = null;
    input.internal_links = [];
    expect(codes(validateWechatMpContent(input))).toEqual(
      expect.arrayContaining([
        'DIGEST_REQUIRED',
        'LEAD_REQUIRED',
        'INTERNAL_LINK_REQUIRED',
        'CTA_REQUIRED',
      ]),
    );
  });

  it('accepts a non-empty CTA block when the top-level CTA is null', async () => {
    const input = (await readJson('wechat_mp.valid.input.json')) as {
      content: { blocks: { block_key: string; block_type: string; text: string }[]; cta: null };
    };
    input.content.cta = null;
    input.content.blocks.push({ block_key: 'final-cta', block_type: 'cta', text: '继续阅读。' });
    expect(codes(validateWechatMpContent(input))).not.toContain('CTA_REQUIRED');
  });

  it('blocks paragraphs over the versioned mobile-reading limit', async () => {
    const input = (await readJson('wechat_mp.valid.input.json')) as {
      content: { blocks: { text: string }[] };
    };
    input.content.blocks[0]!.text = '长'.repeat(301);
    expect(codes(validateWechatMpContent(input))).toContain('PARAGRAPH_TOO_LONG');
  });

  it('blocks referenced citations without output links', async () => {
    const input = (await readJson('wechat_mp.valid.input.json')) as { citations: unknown[] };
    input.citations = [];
    expect(codes(validateWechatMpContent(input))).toContain('CITATION_LINK_MISSING');
  });

  it('escapes untrusted content and preserves safe links', async () => {
    const input = (await readJson('wechat_mp.valid.input.json')) as {
      content: { blocks: { text: string }[] };
    };
    input.content.blocks[3]!.text += '<script>alert("x")</script>';
    const result = renderWechatMp(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.body_html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(result.payload.body_html).not.toContain('<script>alert');
    expect(result.payload.body_html).toContain('rel="noopener noreferrer"');
  });

  it('rejects unknown input fields before platform rules', async () => {
    const input = (await readJson('wechat_mp.valid.input.json')) as Record<string, unknown>;
    input['unexpected'] = true;
    expect(codes(validateWechatMpContent(input))).toEqual(['PAYLOAD_SCHEMA_INVALID']);
  });
});

interface ValidGolden {
  author: string;
  citation_link_count: number;
  internal_link_count: number;
  payload_sha256: string;
  platform_code: string;
  rule_version: string;
  schema_version: string;
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

function codes(result: ReturnType<typeof validateWechatMpContent>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

async function readJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl(name), 'utf8')) as unknown;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
