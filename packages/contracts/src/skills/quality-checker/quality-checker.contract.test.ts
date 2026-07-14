import { describe, expect, it } from 'vitest';

import { QUALITY_CHECKER_CONTRACT_V1 } from '../../../../skills/quality-checker/contracts/v1.0.0/index.js';
import { SchemaGuard } from '../../../../skills/runtime/schema-guard.js';
import {
  CREATE_QUALITY_ISSUE_TOOL,
  GET_PLATFORM_RULES_TOOL,
  REQUEST_HUMAN_REVIEW_TOOL,
  SEARCH_KNOWLEDGE_TOOL,
} from '../tool-definitions.js';
import {
  QUALITY_CHECKER_DATA_SCHEMA,
  QUALITY_CHECKER_INPUT_SCHEMA,
  QUALITY_CHECKER_OUTPUT_SCHEMA,
} from './quality-checker.schemas.js';

const guard = new SchemaGuard();

describe('quality-checker contract v1.0.0', () => {
  it('keeps all versioned few-shot inputs and outputs schema-valid', () => {
    for (const fixture of QUALITY_CHECKER_CONTRACT_V1.fewShots) {
      expect(guard.check(QUALITY_CHECKER_INPUT_SCHEMA, fixture.input), fixture.id).toMatchObject({
        valid: true,
      });
      expect(
        guard.check(QUALITY_CHECKER_DATA_SCHEMA, fixture.output.data),
        fixture.id,
      ).toMatchObject({
        valid: true,
      });
      expect(guard.check(QUALITY_CHECKER_OUTPUT_SCHEMA, fixture.output), fixture.id).toMatchObject({
        valid: true,
      });
    }
  });

  it('allows only scoped reads, temporary issue writes, and human review requests', () => {
    expect(QUALITY_CHECKER_CONTRACT_V1.toolNames).toEqual([
      'search_knowledge',
      'get_platform_rules',
      'create_quality_issue',
      'request_human_review',
    ]);
    expect(
      JSON.stringify([
        SEARCH_KNOWLEDGE_TOOL,
        GET_PLATFORM_RULES_TOOL,
        CREATE_QUALITY_ISSUE_TOOL,
        REQUEST_HUMAN_REVIEW_TOOL,
      ]),
    ).not.toContain('tenant_id');
  });

  it('requires block decisions to contain BLOCK and forbids BLOCK on pass or revise', () => {
    const blocked = QUALITY_CHECKER_CONTRACT_V1.fewShots[1]!.output.data;
    const passed = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!.output.data;
    expect(guard.check(QUALITY_CHECKER_DATA_SCHEMA, { ...blocked, issues: [] })).toMatchObject({
      valid: false,
    });
    expect(
      guard.check(QUALITY_CHECKER_DATA_SCHEMA, {
        ...passed,
        issues: blocked.issues,
      }),
    ).toMatchObject({ valid: false });
  });

  it('applies the configured warning threshold to pass and revise fixtures', () => {
    for (const fixture of QUALITY_CHECKER_CONTRACT_V1.fewShots) {
      const policy = fixture.input['safety_policy'] as { max_warnings_for_pass: number };
      const warningCount = fixture.output.data.issues.filter(
        (candidate) => candidate.severity === 'WARN',
      ).length;
      if (fixture.output.data.decision === 'pass') {
        expect(warningCount).toBeLessThanOrEqual(policy.max_warnings_for_pass);
      }
      if (fixture.output.data.decision === 'revise') {
        expect(warningCount).toBeGreaterThan(policy.max_warnings_for_pass);
      }
    }
  });

  it('blocks the frozen WeChat title hard-limit fixture', () => {
    const fixture = QUALITY_CHECKER_CONTRACT_V1.fewShots[1]!;
    const content = fixture.input['content_version'] as { content: { title: string } };
    expect([...content.content.title].length).toBeGreaterThan(64);
    expect(fixture.output.data.decision).toBe('block');
    expect(fixture.output.data.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'format', severity: 'BLOCK' })]),
    );
  });

  it('blocks high-risk unsupported facts without inventing citations', () => {
    const fixture = QUALITY_CHECKER_CONTRACT_V1.fewShots[1]!;
    const factResults = fixture.input['fact_results'] as readonly {
      citation_ids: readonly string[];
      risk_level: string;
      verdict: string;
    }[];
    expect(factResults[0]).toMatchObject({
      citation_ids: [],
      risk_level: 'high',
      verdict: 'unsupported',
    });
    expect(fixture.output.data.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'fact', severity: 'BLOCK' })]),
    );
  });

  it('preserves supplied GEO sub-scores exactly', () => {
    for (const fixture of QUALITY_CHECKER_CONTRACT_V1.fewShots) {
      const geoResult = fixture.input['geo_result'] as { scores: unknown };
      expect(fixture.output.data.geo_scores).toEqual(geoResult.scores);
    }
  });

  it('does not accept model-owned tenant scope or workflow state', () => {
    const fixture = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    expect(
      guard.check(QUALITY_CHECKER_INPUT_SCHEMA, { ...fixture.input, tenant_id: 'untrusted' }),
    ).toMatchObject({ valid: false });
    expect(
      guard.check(QUALITY_CHECKER_DATA_SCHEMA, {
        ...fixture.output.data,
        variant_status: 'approved',
      }),
    ).toMatchObject({ valid: false });
  });
});
