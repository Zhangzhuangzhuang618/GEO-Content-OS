import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { renderDouyin } from './src/render.js';
import { DOUYIN_RENDER_RULES_V1 } from './src/rules.js';
import { DOUYIN_PAYLOAD_JSON_SCHEMA, DOUYIN_RENDER_INPUT_JSON_SCHEMA } from './src/schema.js';
import { validateDouyinContent } from './src/validate.js';

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe('douyin render contract', () => {
  it('publishes immutable versioned rules and Draft 2020-12 schemas', async () => {
    expect(DOUYIN_RENDER_RULES_V1.version).toBe('douyin-render-rules@1.0.0');
    expect(Object.isFrozen(DOUYIN_RENDER_RULES_V1)).toBe(true);
    expect(Object.isFrozen(DOUYIN_RENDER_RULES_V1.productionClaimMarkers)).toBe(true);
    expect(DOUYIN_RENDER_INPUT_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(DOUYIN_PAYLOAD_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    const input = await readJson('douyin.valid.input.json');
    const inputValidator = validator(DOUYIN_RENDER_INPUT_JSON_SCHEMA);
    expect(inputValidator(input), errors(inputValidator.errors)).toBe(true);
  });

  it('matches the deterministic valid golden fixture', async () => {
    const input = await readJson('douyin.valid.input.json');
    const golden = (await readJson('douyin.valid.golden.json')) as ValidGolden;
    const result = renderDouyin(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payloadValidator = validator(DOUYIN_PAYLOAD_JSON_SCHEMA);
    expect(payloadValidator(result.payload), errors(payloadValidator.errors)).toBe(true);
    expect(result.payload).toMatchObject({
      duration_seconds: golden.duration_seconds,
      platform_code: golden.platform_code,
      rule_version: golden.rule_version,
      schema_version: golden.schema_version,
      script_kind: 'script_package',
    });
    expect(result.payload.storyboard).toHaveLength(golden.storyboard_count);
    expect(result.payload.subtitles).toHaveLength(golden.subtitle_count);
    expect(result.payload.topics).toHaveLength(golden.topic_count);
    expect(result.payload.citation_links).toHaveLength(golden.citation_link_count);
    expect(sha256(result.payload)).toBe(golden.payload_sha256);
  });

  it('matches blocker golden and never renders invalid content', async () => {
    const input = await readJson('douyin.invalid.input.json');
    const golden = (await readJson('douyin.invalid.golden.json')) as { blocker_codes: string[] };
    const validation = validateDouyinContent(input);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.map((issue) => issue.code).sort()).toEqual(golden.blocker_codes);
    expect(renderDouyin(input)).toEqual(validation);
  });

  it('requires a complete first scene within the first three seconds', async () => {
    const input = (await readJson('douyin.valid.input.json')) as {
      content: { platform_meta: { storyboard: { end_second: number }[] } };
    };
    input.content.platform_meta.storyboard[0]!.end_second = 4;
    expect(codes(validateDouyinContent(input))).toContain('HOOK_REQUIRED');
  });

  it('requires storyboard, subtitles and topics', async () => {
    const input = (await readJson('douyin.valid.input.json')) as {
      content: { platform_meta: { storyboard: unknown[]; subtitles: unknown[]; topics: unknown[] } };
    };
    input.content.platform_meta.storyboard = [];
    input.content.platform_meta.subtitles = [];
    input.content.platform_meta.topics = [];
    expect(codes(validateDouyinContent(input))).toEqual(
      expect.arrayContaining(['STORYBOARD_REQUIRED', 'SUBTITLE_REQUIRED', 'TOPIC_REQUIRED']),
    );
  });

  it('blocks timeline entries outside the declared duration', async () => {
    const input = (await readJson('douyin.valid.input.json')) as {
      content: { platform_meta: { duration_seconds: number } };
    };
    input.content.platform_meta.duration_seconds = 29;
    expect(codes(validateDouyinContent(input))).toContain('DURATION_MISMATCH');
  });

  it('blocks overlapping or out-of-order timeline entries', async () => {
    const input = (await readJson('douyin.valid.input.json')) as {
      content: { platform_meta: { storyboard: { start_second: number }[] } };
    };
    input.content.platform_meta.storyboard[1]!.start_second = 2;
    expect(codes(validateDouyinContent(input))).toContain('DURATION_MISMATCH');
  });

  it('blocks claims that a video was already produced or published', async () => {
    const input = (await readJson('douyin.valid.input.json')) as { content: { summary: string } };
    input.content.summary = '视频已发布，请直接查看成片。';
    expect(codes(validateDouyinContent(input))).toContain('PRODUCTION_CLAIM_FORBIDDEN');
  });

  it('blocks referenced citations without output links', async () => {
    const input = (await readJson('douyin.valid.input.json')) as { citations: unknown[] };
    input.citations = [];
    expect(codes(validateDouyinContent(input))).toContain('CITATION_LINK_MISSING');
  });

  it('renders a script package without claiming a produced video', async () => {
    const result = renderDouyin(await readJson('douyin.valid.input.json'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.script_text).toContain('脚本类型：抖音口播脚本包（不含成片）');
    expect(result.payload.script_text).not.toContain('视频已制作');
    expect(result.payload.hook).toBe(result.payload.storyboard[0]!.voiceover);
  });

  it('rejects unknown input fields before platform rules', async () => {
    const input = (await readJson('douyin.valid.input.json')) as Record<string, unknown>;
    input['unexpected'] = true;
    expect(codes(validateDouyinContent(input))).toEqual(['PAYLOAD_SCHEMA_INVALID']);
  });
});

interface ValidGolden {
  citation_link_count: number;
  duration_seconds: number;
  payload_sha256: string;
  platform_code: string;
  rule_version: string;
  schema_version: string;
  storyboard_count: number;
  subtitle_count: number;
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
function codes(result: ReturnType<typeof validateDouyinContent>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}
async function readJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl(name), 'utf8')) as unknown;
}
function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
