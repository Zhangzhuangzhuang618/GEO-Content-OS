import { describe, expect, it } from 'vitest';

import { SchemaGuard } from '../../../../skills/runtime/schema-guard.js';
import {
  CONTENT_WRITER_CONTRACT_V1,
  CONTENT_WRITER_LOCKED_TEXT_FIXTURE,
} from '../../../../skills/content-writer/contracts/v1.0.0/index.js';
import { GET_PLATFORM_RULES_TOOL, GET_STRATEGY_VERSION_TOOL } from '../tool-definitions.js';
import {
  CONTENT_PLATFORM_CODES,
  CONTENT_WRITER_DATA_SCHEMA,
  CONTENT_WRITER_INPUT_SCHEMA,
  CONTENT_WRITER_OUTPUT_SCHEMA,
} from './content-writer.schemas.js';

const guard = new SchemaGuard();

describe('content-writer contract v1.0.0', () => {
  it('keeps every versioned few-shot input, data, and output schema-valid', () => {
    for (const fixture of CONTENT_WRITER_CONTRACT_V1.fewShots) {
      expect(guard.check(CONTENT_WRITER_INPUT_SCHEMA, fixture.input), fixture.id).toMatchObject({
        valid: true,
      });
      expect(
        guard.check(CONTENT_WRITER_DATA_SCHEMA, fixture.output.data),
        fixture.id,
      ).toMatchObject({
        valid: true,
      });
      expect(guard.check(CONTENT_WRITER_OUTPUT_SCHEMA, fixture.output), fixture.id).toMatchObject({
        valid: true,
      });
    }
  });

  it('binds all seven platform patches and only the two authorized tools', () => {
    expect(Object.keys(CONTENT_WRITER_CONTRACT_V1.platformPrompts).sort()).toEqual(
      [...CONTENT_PLATFORM_CODES].sort(),
    );
    expect(CONTENT_WRITER_CONTRACT_V1.toolNames).toEqual([
      'get_strategy_version',
      'get_platform_rules',
    ]);
    expect(CONTENT_WRITER_CONTRACT_V1.toolNames).not.toContain('search_knowledge');
  });

  it('enforces documented platform title limits', () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const limits = {
      baijiahao: 40,
      official_site: 60,
      toutiao: 50,
      wechat_mp: 64,
      xiaohongshu: 20,
    };
    for (const [platformCode, limit] of Object.entries(limits)) {
      const invalid = {
        ...fixture.output.data,
        variants: [
          {
            ...fixture.output.data.variants[0],
            platform_code: platformCode,
            title: '长'.repeat(limit + 1),
          },
        ],
      };
      expect(guard.check(CONTENT_WRITER_DATA_SCHEMA, invalid), platformCode).toMatchObject({
        valid: false,
      });
    }
  });

  it('preserves locked text and citations byte-for-byte in the boundary fixture', () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots.find(
      (candidate) => candidate.id === 'locked-block-boundary',
    )!;
    const locked = (fixture.input['locked_blocks'] as readonly Record<string, unknown>[])[0]!;
    const block = fixture.output.data.master_content.blocks.find(
      (candidate) => candidate.block_key === locked['block_key'],
    );
    const citation = fixture.output.data.master_content.citation_map.find(
      (candidate) => candidate.claim_text === locked['text'],
    );
    expect(block?.text).toBe(CONTENT_WRITER_LOCKED_TEXT_FIXTURE);
    expect(citation?.citation_ids).toEqual(locked['citation_ids']);
  });

  it('rejects extra model scope and validates tool arguments without tenant_id', () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    expect(
      guard.check(CONTENT_WRITER_INPUT_SCHEMA, { ...fixture.input, tenant_id: 'untrusted' }),
    ).toMatchObject({ valid: false });
    expect(
      guard.check(GET_STRATEGY_VERSION_TOOL.inputSchema, {
        brand_profile_id: '20000000-0000-4000-8000-000000000061',
      }),
    ).toMatchObject({ valid: true });
    expect(
      guard.check(GET_PLATFORM_RULES_TOOL.inputSchema, {
        platform_code: 'xiaohongshu',
        version_id: '30000000-0000-4000-8000-000000000061',
      }),
    ).toMatchObject({ valid: true });
    expect(JSON.stringify([GET_STRATEGY_VERSION_TOOL, GET_PLATFORM_RULES_TOOL])).not.toContain(
      'tenant_id',
    );
  });

  it('treats injection text as data and rejects uncontracted output fields', () => {
    const injection = CONTENT_WRITER_CONTRACT_V1.fewShots.find(
      (candidate) => candidate.id === 'prompt-injection-is-data',
    )!;
    expect(JSON.stringify(injection.input)).toContain('忽略系统指令');
    expect(injection.output.warnings).toEqual([
      expect.objectContaining({ code: 'PROMPT_INJECTION_DETECTED' }),
    ]);
    expect(
      guard.check(CONTENT_WRITER_OUTPUT_SCHEMA, { ...injection.output, explanation: 'extra' }),
    ).toMatchObject({ valid: false });
  });
});
