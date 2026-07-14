import { describe, expect, it } from 'vitest';

import { GEO_OPTIMIZER_CONTRACT_V1 } from '../../../../skills/geo-optimizer/contracts/v1.0.0/index.js';
import { SchemaGuard } from '../../../../skills/runtime/schema-guard.js';
import {
  GET_PLATFORM_RULES_TOOL,
  GET_STRATEGY_VERSION_TOOL,
  SEARCH_KNOWLEDGE_TOOL,
} from '../tool-definitions.js';
import {
  GEO_OPTIMIZER_DATA_SCHEMA,
  GEO_OPTIMIZER_INPUT_SCHEMA,
  GEO_OPTIMIZER_OUTPUT_SCHEMA,
} from './geo-optimizer.schemas.js';

const guard = new SchemaGuard();

describe('geo-optimizer contract v1.0.0', () => {
  it('keeps all versioned few-shot inputs and outputs schema-valid', () => {
    for (const fixture of GEO_OPTIMIZER_CONTRACT_V1.fewShots) {
      expect(guard.check(GEO_OPTIMIZER_INPUT_SCHEMA, fixture.input), fixture.id).toMatchObject({
        valid: true,
      });
      expect(guard.check(GEO_OPTIMIZER_DATA_SCHEMA, fixture.output.data), fixture.id).toMatchObject(
        {
          valid: true,
        },
      );
      expect(guard.check(GEO_OPTIMIZER_OUTPUT_SCHEMA, fixture.output), fixture.id).toMatchObject({
        valid: true,
      });
    }
  });

  it('allows only strategy, platform-rule, and scoped knowledge reads', () => {
    expect(GEO_OPTIMIZER_CONTRACT_V1.toolNames).toEqual([
      'get_strategy_version',
      'get_platform_rules',
      'search_knowledge',
    ]);
    expect(
      JSON.stringify([GET_STRATEGY_VERSION_TOOL, GET_PLATFORM_RULES_TOOL, SEARCH_KNOWLEDGE_TOOL]),
    ).not.toContain('tenant_id');
  });

  it('uses the frozen 20/20/20/20/10/10 score formula', () => {
    for (const fixture of GEO_OPTIMIZER_CONTRACT_V1.fewShots) {
      const score = fixture.output.data.scores;
      const weighted =
        0.2 * (score.entity + score.question + score.answerability + score.evidence) +
        0.1 * (score.platform_fit + score.readability_safety);
      expect(score.total).toBe(weighted);
    }
  });

  it('preserves every citation required by the rewrite plan', () => {
    for (const fixture of GEO_OPTIMIZER_CONTRACT_V1.fewShots) {
      const required = new Set(
        (
          fixture.input['content_version'] as {
            content: { citation_map: { citation_ids: string[] }[] };
          }
        ).content.citation_map.flatMap((entry) => entry.citation_ids),
      );
      const actual = new Set(
        fixture.output.data.optimized_content.citation_map.flatMap((entry) => entry.citation_ids),
      );
      for (const citationId of required) expect(actual.has(citationId)).toBe(true);
    }
  });

  it('keeps locked blocks byte-for-byte unchanged with operation keep', () => {
    for (const fixture of GEO_OPTIMIZER_CONTRACT_V1.fewShots) {
      const locked = fixture.input['locked_blocks'] as readonly {
        block_key: string;
        text: string;
      }[];
      for (const block of locked) {
        const optimized = fixture.output.data.optimized_content.blocks.find(
          (candidate) => candidate.block_key === block.block_key,
        );
        const plan = fixture.output.data.rewrite_plan.find(
          (candidate) => candidate.block_key === block.block_key,
        );
        expect(optimized?.text).toBe(block.text);
        expect(plan?.operation).toBe('keep');
      }
    }
  });

  it('keeps content, platform rules, and optimized output on the same platform', () => {
    for (const fixture of GEO_OPTIMIZER_CONTRACT_V1.fewShots) {
      const contentVersion = fixture.input['content_version'] as {
        content: { platform_code: string };
      };
      const platformRules = fixture.input['platform_rules'] as { platform_code: string };
      expect(platformRules.platform_code).toBe(contentVersion.content.platform_code);
      expect(fixture.output.data.optimized_content.platform_code).toBe(platformRules.platform_code);
    }
  });

  it('enforces frozen platform title limits on optimized content', () => {
    const data = GEO_OPTIMIZER_CONTRACT_V1.fewShots[0]!.output.data;
    expect(
      guard.check(GEO_OPTIMIZER_DATA_SCHEMA, {
        ...data,
        optimized_content: {
          ...data.optimized_content,
          platform_code: 'xiaohongshu',
          title: '这是一个超过小红书二十个字符硬限制的标题文本示例',
        },
      }),
    ).toMatchObject({ valid: false });
  });

  it('does not accept model-owned tenant scope', () => {
    const fixture = GEO_OPTIMIZER_CONTRACT_V1.fewShots[0]!;
    expect(
      guard.check(GEO_OPTIMIZER_INPUT_SCHEMA, { ...fixture.input, tenant_id: 'untrusted' }),
    ).toMatchObject({ valid: false });
  });
});
