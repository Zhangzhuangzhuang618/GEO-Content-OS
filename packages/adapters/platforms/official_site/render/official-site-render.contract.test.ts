import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  OFFICIAL_SITE_PAYLOAD_JSON_SCHEMA,
  OFFICIAL_SITE_RENDER_INPUT_JSON_SCHEMA,
} from './src/schema.js';
import { renderOfficialSite } from './src/render.js';
import { OFFICIAL_SITE_RENDER_RULES_V1 } from './src/rules.js';
import { validateOfficialSiteContent } from './src/validate.js';

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe('official_site render contract', () => {
  it('publishes immutable versioned rules and Draft 2020-12 payload schemas', async () => {
    expect(OFFICIAL_SITE_RENDER_RULES_V1.version).toBe('official-site-render-rules@1.1.0');
    expect(Object.isFrozen(OFFICIAL_SITE_RENDER_RULES_V1)).toBe(true);
    expect(Object.isFrozen(OFFICIAL_SITE_RENDER_RULES_V1.title)).toBe(true);
    expect(OFFICIAL_SITE_RENDER_INPUT_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(OFFICIAL_SITE_PAYLOAD_JSON_SCHEMA.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );

    const input = await readJson('official-site.valid.input.json');
    const inputValidator = validator(OFFICIAL_SITE_RENDER_INPUT_JSON_SCHEMA);
    expect(
      inputValidator(input),
      inputValidator.errors?.map((error) => error.message).join('; '),
    ).toBe(true);
  });

  it('matches the deterministic valid golden fixture', async () => {
    const input = await readJson('official-site.valid.input.json');
    const golden = (await readJson('official-site.valid.golden.json')) as {
      readonly citation_link_count: number;
      readonly payload_sha256: string;
      readonly platform_code: string;
      readonly rule_version: string;
      readonly schema_version: string;
      readonly slug: string;
    };
    const result = renderOfficialSite(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payloadValidator = validator(OFFICIAL_SITE_PAYLOAD_JSON_SCHEMA);
    expect(
      payloadValidator(result.payload),
      payloadValidator.errors?.map((error) => error.message).join('; '),
    ).toBe(true);
    expect(result.payload).toMatchObject({
      platform_code: golden.platform_code,
      rule_version: golden.rule_version,
      schema_version: golden.schema_version,
      slug: golden.slug,
    });
    expect(result.payload.citation_links).toHaveLength(golden.citation_link_count);
    expect(result.payload.body_html).not.toContain('<h1>');
    expect(result.payload.body_html).not.toContain('<script');
    expect(result.payload.summary).toBe(
      (input as { content: { summary: string } }).content.summary,
    );
    expect(result.payload.seo_keywords).toEqual(
      (input as { content: { hashtags: string[] } }).content.hashtags,
    );
    expect(sha256(result.payload)).toBe(golden.payload_sha256);
  });

  it('matches the blocker golden fixture and never renders invalid content', async () => {
    const input = await readJson('official-site.invalid.input.json');
    const golden = (await readJson('official-site.invalid.golden.json')) as {
      readonly blocker_codes: readonly string[];
    };
    const validation = validateOfficialSiteContent(input);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.map((issue) => issue.code).sort()).toEqual(golden.blocker_codes);
    expect(validation.issues.every((issue) => issue.severity === 'blocker')).toBe(true);
    expect(renderOfficialSite(input)).toEqual(validation);
  });

  it('blocks over-length content instead of truncating facts or citations', async () => {
    const input = (await readJson('official-site.valid.input.json')) as {
      content: { blocks: { block_type: string; text: string }[] };
    };
    const paragraph = input.content.blocks.find((block) => block.block_type === 'paragraph');
    if (!paragraph) throw new Error('Golden fixture is missing a paragraph');
    paragraph.text += '超'.repeat(3_000);

    const result = renderOfficialSite(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('BODY_LENGTH_OUT_OF_RANGE');
  });

  it('uses the same effective-character body count as official-site generation', async () => {
    const input = (await readJson('official-site.valid.input.json')) as {
      content: { blocks: { block_type: string; text: string }[] };
    };
    const body = input.content.blocks
      .filter((block) => block.block_type !== 'heading' && block.block_type !== 'media')
      .map((block) => block.text)
      .join('');
    const effectiveLength = body.replace(/[\s\p{P}\p{S}]/gu, '').length;
    const paragraph = input.content.blocks.find((block) => block.block_type === 'paragraph');
    if (!paragraph) throw new Error('Golden fixture is missing a paragraph');
    paragraph.text += `${'超'.repeat(2_500 - effectiveLength)}${'，'.repeat(300)}`;

    const result = renderOfficialSite(input);
    expect(result.ok).toBe(true);
  });

  it('does not count an empty heading as the required H2', async () => {
    const input = (await readJson('official-site.valid.input.json')) as {
      content: { blocks: { block_type: string; text: string }[] };
    };
    for (const block of input.content.blocks) {
      if (block.block_type === 'heading') block.text = '   ';
    }

    const result = validateOfficialSiteContent(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('H2_REQUIRED');
  });

  it('escapes untrusted text while preserving validated citation links', async () => {
    const input = (await readJson('official-site.valid.input.json')) as {
      content: { blocks: { block_type: string; text: string }[] };
    };
    const paragraph = input.content.blocks.find((block) => block.block_type === 'paragraph');
    if (!paragraph) throw new Error('Golden fixture is missing a paragraph');
    paragraph.text += '<script>alert("x")</script>';

    const result = renderOfficialSite(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(result.payload.html).not.toContain('<script>alert');
    expect(result.payload.html).toContain('rel="noopener noreferrer"');
  });

  it('rejects unknown payload fields before applying platform rules', async () => {
    const input = (await readJson('official-site.valid.input.json')) as Record<string, unknown>;
    input['unexpected'] = true;
    const result = validateOfficialSiteContent(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(['PAYLOAD_SCHEMA_INVALID']);
  });

  it('allows first-party official-site content without a third-party citation', async () => {
    const input = (await readJson('official-site.valid.input.json')) as {
      citations: unknown[];
      content: { citation_map: unknown[] };
    };
    input.citations = [];
    input.content.citation_map = [];

    const result = renderOfficialSite(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.citation_links).toEqual([]);
    expect(result.payload.body_html).not.toContain('参考资料');
  });

  it('keeps internal documentary evidence private while rendering public links only', async () => {
    const input = (await readJson('official-site.valid.input.json')) as {
      citations: unknown[];
      content: { citation_map: unknown[] };
    };
    expect(input.content.citation_map).not.toEqual([]);
    input.citations = [];

    const result = renderOfficialSite(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.citation_links).toEqual([]);
    expect(result.payload.body_html).not.toContain('参考资料');
  });

  it('renders persistent qualified media with an explicit AI illustration disclosure', async () => {
    const input = (await readJson('official-site.valid.input.json')) as Record<string, unknown>;
    input['media_assets'] = [
      {
        alt_text: '搬家验收步骤封面示意图',
        position: 0,
        role: 'cover',
        url: 'https://cdn.example.com/generated-media/cover.jpg',
      },
      {
        alt_text: '逐项清点物品示意图',
        position: 1,
        role: 'body',
        url: 'https://cdn.example.com/generated-media/body-1.jpg',
      },
    ];

    const result = renderOfficialSite(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.body_html).toContain('https://cdn.example.com/generated-media/cover.jpg');
    expect(result.payload.body_html).toContain('逐项清点物品示意图（AI示意图）');
    expect(result.payload.markdown).toContain('![搬家验收步骤封面示意图]');
  });

  it('blocks other company names but permits the owner and anonymous companies', async () => {
    const input = (await readJson('official-site.valid.input.json')) as {
      content: { blocks: { block_type: string; text: string }[] };
    };
    const paragraph = input.content.blocks.find((block) => block.block_type === 'paragraph');
    if (!paragraph) throw new Error('Golden fixture is missing a paragraph');
    paragraph.text +=
      '广州志远搬家服务有限公司会核对服务记录，某公司和某搬家公司也可采用匿名方式说明。';
    expect(renderOfficialSite(input).ok).toBe(true);
    paragraph.text += '广州家盛搬家有限公司不得公开出现。';

    const result = renderOfficialSite(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'OTHER_COMPANY_NAME_FORBIDDEN',
          message: expect.stringContaining('广州家盛搬家有限公司'),
        }),
      ]),
    );
  });
});

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
