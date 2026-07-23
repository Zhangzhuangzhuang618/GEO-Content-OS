import { TOPIC_PLANNER_CONTRACT_V1 } from '@geo-content-os/skills/topic-planner';
import { describe, expect, it } from 'vitest';

import { evaluateTopicPlanner } from './evaluator.js';
import { parseManifest } from './manifest.js';

const EVALUATED_AT = '2026-07-15T00:00:00.000Z';

describe('topic-planner offline evaluation', () => {
  it('passes schema, evidence, safety, scope, brief, and behavior gates', () => {
    expect(
      evaluateTopicPlanner(manifest(), TOPIC_PLANNER_CONTRACT_V1.fewShots, EVALUATED_AT),
    ).toMatchObject({
      metrics: {
        briefLinkage: 1,
        caseCount: 3,
        evidenceIntegrity: 1,
        expectedBehavior: 1,
        noEvidenceSafety: 1,
        schemaValidity: 1,
        scopeCompliance: 1,
      },
      passed: true,
    });
  });

  it('fails an evidence-free low-risk topic', () => {
    const cases = [...TOPIC_PLANNER_CONTRACT_V1.fewShots];
    const boundary = cases[1]!;
    cases[1] = {
      ...boundary,
      output: {
        ...boundary.output,
        data: {
          topics: [
            {
              ...boundary.output.data.topics[0]!,
              risk_level: 'low',
            },
          ],
        },
      },
    };
    expect(evaluateTopicPlanner(manifest(), cases, EVALUATED_AT)).toMatchObject({
      metrics: { noEvidenceSafety: 0.666666666667 },
      passed: false,
    });
  });

  it('rejects a manifest with a different case order', () => {
    const raw = rawManifest();
    raw.case_ids.reverse();
    expect(() =>
      evaluateTopicPlanner(parseManifest(raw), TOPIC_PLANNER_CONTRACT_V1.fewShots),
    ).toThrow(/versioned manifest/u);
  });
});

function manifest() {
  return parseManifest(rawManifest());
}

function rawManifest() {
  return {
    case_ids: [
      'evidenced-topic-positive',
      'evidence-free-topic-boundary',
      'platform-policy-conflict-negative',
    ],
    dataset_version: 'topic-planner-eval-v1',
    schema_version: 'topic-planner-eval-manifest@1',
    thresholds: {
      brief_linkage_minimum: 1,
      evidence_integrity_minimum: 1,
      expected_behavior_minimum: 1,
      no_evidence_safety_minimum: 1,
      schema_validity_minimum: 1,
      scope_compliance_minimum: 1,
    },
  };
}
