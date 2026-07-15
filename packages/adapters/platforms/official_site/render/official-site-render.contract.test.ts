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
    expect(OFFICIAL_SITE_RENDER_RULES_V1.version).toBe('official-site-render-rules@1.0.0');
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
