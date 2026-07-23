import { describe, expect, it } from 'vitest';

import { SchemaGuard } from '../../../../skills/runtime/schema-guard.js';
import { FACT_CHECKER_CONTRACT_V1 } from '../../../../skills/fact-checker/contracts/v1.0.0/index.js';
import { REQUEST_HUMAN_REVIEW_TOOL, SEARCH_KNOWLEDGE_TOOL } from '../tool-definitions.js';
import {
  FACT_CHECKER_DATA_SCHEMA,
  FACT_CHECKER_INPUT_SCHEMA,
  FACT_CHECKER_OUTPUT_SCHEMA,
} from './fact-checker.schemas.js';

const guard = new SchemaGuard();

describe('fact-checker contract v1.0.0', () => {
  it('keeps all versioned few-shot inputs and outputs schema-valid', () => {
    for (const fixture of FACT_CHECKER_CONTRACT_V1.fewShots) {
      expect(guard.check(FACT_CHECKER_INPUT_SCHEMA, fixture.input), fixture.id).toMatchObject({
        valid: true,
      });
      expect(guard.check(FACT_CHECKER_DATA_SCHEMA, fixture.output.data), fixture.id).toMatchObject({
        valid: true,
      });
      expect(guard.check(FACT_CHECKER_OUTPUT_SCHEMA, fixture.output), fixture.id).toMatchObject({
        valid: true,
      });
    }
  });

  it('allows only scoped search and human review tools', () => {
    expect(FACT_CHECKER_CONTRACT_V1.toolNames).toEqual([
      'search_knowledge',
      'request_human_review',
    ]);
    expect(JSON.stringify([SEARCH_KNOWLEDGE_TOOL, REQUEST_HUMAN_REVIEW_TOOL])).not.toContain(
      'tenant_id',
    );
  });

  it('forces unsupported evidence to be empty and other verdicts to contain evidence', () => {
    const supported = FACT_CHECKER_CONTRACT_V1.fewShots[0]!.output.data.results[0]!;
    const unsupported = FACT_CHECKER_CONTRACT_V1.fewShots[1]!.output.data.results[0]!;
    expect(
      guard.check(FACT_CHECKER_DATA_SCHEMA, {
        overall_decision: 'block',
        results: [{ ...unsupported, evidences: supported.evidences }],
      }),
    ).toMatchObject({ valid: false });
    expect(
      guard.check(FACT_CHECKER_DATA_SCHEMA, {
        overall_decision: 'pass',
        results: [{ ...supported, evidences: [] }],
      }),
    ).toMatchObject({ valid: false });
  });

  it('keeps every quoted evidence as a continuous returned chunk substring', () => {
    for (const fixture of FACT_CHECKER_CONTRACT_V1.fewShots) {
      for (const evidence of fixture.output.data.results[0]!.evidences) {
        const chunk = fixture.toolResults.find(
          (result) => result['chunk_id'] === evidence.chunk_id,
        );
        expect(chunk?.['quote_text']).toEqual(expect.stringContaining(evidence.quote_text));
      }
    }
  });

  it('never accepts model-owned tenant scope or claim_hash', () => {
    const fixture = FACT_CHECKER_CONTRACT_V1.fewShots[0]!;
    expect(
      guard.check(FACT_CHECKER_INPUT_SCHEMA, { ...fixture.input, tenant_id: 'untrusted' }),
    ).toMatchObject({ valid: false });
    expect(JSON.stringify([FACT_CHECKER_INPUT_SCHEMA, FACT_CHECKER_DATA_SCHEMA])).not.toContain(
      'claim_hash',
    );
  });
});
