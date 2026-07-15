import { FACT_CHECKER_CONTRACT_V1 } from '@geo-content-os/skills/fact-checker';
import { describe, expect, it } from 'vitest';

import { evaluateFactChecker } from './evaluator.js';
import { parseManifest } from './manifest.js';

const EVALUATED_AT = '2026-07-15T00:00:00.000Z';

describe('fact-checker offline evaluation', () => {
  it('passes claim, evidence, risk, quote, and behavior gates', () => {
    expect(
      evaluateFactChecker(manifest(), FACT_CHECKER_CONTRACT_V1.fewShots, EVALUATED_AT),
    ).toMatchObject({
      metrics: {
        caseCount: 3,
        claimCoverage: 1,
        evidenceRule: 1,
        expectedBehavior: 1,
        highRiskDecision: 1,
        quoteIntegrity: 1,
        schemaValidity: 1,
      },
      passed: true,
    });
  });

  it('fails a fabricated evidence quote', () => {
    const cases = [...FACT_CHECKER_CONTRACT_V1.fewShots];
    const positive = cases[0]!;
    cases[0] = {
      ...positive,
      output: {
        ...positive.output,
        data: {
          ...positive.output.data,
          results: [
            {
              ...positive.output.data.results[0]!,
              evidences: [
                { ...positive.output.data.results[0]!.evidences[0]!, quote_text: '伪造原文' },
              ],
            },
          ],
        },
      },
    };
    expect(evaluateFactChecker(manifest(), cases, EVALUATED_AT)).toMatchObject({
      metrics: { quoteIntegrity: 0.666666666667 },
      passed: false,
    });
  });

  it('rejects a manifest with a different case order', () => {
    const raw = rawManifest();
    raw.case_ids.reverse();
    expect(() =>
      evaluateFactChecker(parseManifest(raw), FACT_CHECKER_CONTRACT_V1.fewShots),
    ).toThrow(/versioned manifest/u);
  });
});

function manifest() {
  return parseManifest(rawManifest());
}
function rawManifest() {
  return {
    case_ids: [
      'supported-date-positive',
      'unsupported-market-leader-negative',
      'outdated-capability-boundary',
    ],
    dataset_version: 'fact-checker-eval-v1',
    schema_version: 'fact-checker-eval-manifest@1',
    thresholds: {
      claim_coverage_minimum: 1,
      evidence_rule_minimum: 1,
      expected_behavior_minimum: 1,
      high_risk_decision_minimum: 1,
      quote_integrity_minimum: 1,
      schema_validity_minimum: 1,
    },
  };
}
