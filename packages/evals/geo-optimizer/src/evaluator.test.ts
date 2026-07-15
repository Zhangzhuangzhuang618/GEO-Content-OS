import { GEO_OPTIMIZER_CONTRACT_V1 } from '@geo-content-os/skills/geo-optimizer';
import { describe, expect, it } from 'vitest';

import { evaluateGeoOptimizer } from './evaluator.js';
import { parseManifest } from './manifest.js';

const EVALUATED_AT = '2026-07-15T00:00:00.000Z';

describe('geo-optimizer offline evaluation', () => {
  it('passes schema, score, citation, lock, plan, and behavior gates', () => {
    expect(
      evaluateGeoOptimizer(manifest(), GEO_OPTIMIZER_CONTRACT_V1.fewShots, EVALUATED_AT),
    ).toMatchObject({
      metrics: {
        caseCount: 3,
        citationIntegrity: 1,
        expectedBehavior: 1,
        lockIntegrity: 1,
        rewritePlanIntegrity: 1,
        schemaValidity: 1,
        weightedScore: 1,
      },
      passed: true,
    });
  });

  it('fails a changed locked block', () => {
    const cases = [...GEO_OPTIMIZER_CONTRACT_V1.fewShots];
    const boundary = cases[2]!;
    cases[2] = {
      ...boundary,
      output: {
        ...boundary.output,
        data: {
          ...boundary.output.data,
          optimized_content: {
            ...boundary.output.data.optimized_content,
            blocks: boundary.output.data.optimized_content.blocks.map((block) =>
              block.block_key === 'legal' ? { ...block, text: 'Changed legal text.' } : block,
            ),
          },
        },
      },
    };
    expect(evaluateGeoOptimizer(manifest(), cases, EVALUATED_AT)).toMatchObject({
      metrics: { lockIntegrity: 0.666666666667 },
      passed: false,
    });
  });

  it('rejects a manifest with a different case order', () => {
    const raw = rawManifest();
    raw.case_ids.reverse();
    expect(() =>
      evaluateGeoOptimizer(parseManifest(raw), GEO_OPTIMIZER_CONTRACT_V1.fewShots),
    ).toThrow(/versioned manifest/u);
  });
});

function manifest() {
  return parseManifest(rawManifest());
}

function rawManifest() {
  return {
    case_ids: ['answerability-positive', 'citation-loss-negative', 'locked-block-boundary'],
    dataset_version: 'geo-optimizer-eval-v1',
    schema_version: 'geo-optimizer-eval-manifest@1',
    thresholds: {
      citation_integrity_minimum: 1,
      expected_behavior_minimum: 1,
      lock_integrity_minimum: 1,
      rewrite_plan_integrity_minimum: 1,
      schema_validity_minimum: 1,
      weighted_score_minimum: 1,
    },
  };
}
