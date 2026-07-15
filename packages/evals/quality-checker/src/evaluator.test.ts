import { QUALITY_CHECKER_CONTRACT_V1 } from '@geo-content-os/skills/quality-checker';
import { describe, expect, it } from 'vitest';
import { evaluateQualityChecker } from './evaluator.js';
import { parseManifest } from './manifest.js';
const EVALUATED_AT = '2026-07-15T00:00:00.000Z';
describe('quality-checker offline evaluation', () => {
  it('passes all frozen quality gates', () => {
    expect(
      evaluateQualityChecker(manifest(), QUALITY_CHECKER_CONTRACT_V1.fewShots, EVALUATED_AT),
    ).toMatchObject({
      metrics: {
        caseCount: 3,
        decisionGate: 1,
        expectedBehavior: 1,
        geoIntegrity: 1,
        hardRule: 1,
        schemaValidity: 1,
      },
      passed: true,
    });
  });
  it('fails when the warning threshold decision is changed to pass', () => {
    const cases = [...QUALITY_CHECKER_CONTRACT_V1.fewShots];
    const boundary = cases[2]!;
    cases[2] = {
      ...boundary,
      output: { ...boundary.output, data: { ...boundary.output.data, decision: 'pass' } },
    };
    expect(evaluateQualityChecker(manifest(), cases, EVALUATED_AT)).toMatchObject({
      metrics: { decisionGate: 0.666666666667 },
      passed: false,
    });
  });
  it('rejects a manifest with a different case order', () => {
    const raw = rawManifest();
    raw.case_ids.reverse();
    expect(() =>
      evaluateQualityChecker(parseManifest(raw), QUALITY_CHECKER_CONTRACT_V1.fewShots),
    ).toThrow(/versioned manifest/u);
  });
});
function manifest() {
  return parseManifest(rawManifest());
}
function rawManifest() {
  return {
    case_ids: [
      'clean-content-positive',
      'wechat-title-hard-limit-negative',
      'warning-threshold-boundary',
    ],
    dataset_version: 'quality-checker-eval-v1',
    schema_version: 'quality-checker-eval-manifest@1',
    thresholds: {
      decision_gate_minimum: 1,
      expected_behavior_minimum: 1,
      geo_integrity_minimum: 1,
      hard_rule_minimum: 1,
      schema_validity_minimum: 1,
    },
  };
}
