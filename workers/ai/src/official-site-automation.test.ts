import type { QualityCheckerData, QualityGeoScores } from '@geo-content-os/contracts/skills';
import { describe, expect, it } from 'vitest';

import { GenerationWorkerError } from './generation.errors.js';
import {
  OfficialSiteAutomation,
  type OfficialSiteAutomationPolicy,
} from './official-site-automation.js';
import { validateOfficialSiteRewriteEvent } from './official-site-rewrite.event.js';

const VARIANT_ID = '70000000-0000-4000-8000-000000000201';
const EVENT = {
  aggregate: { id: VARIANT_ID, type: 'content_variant' },
  data: {
    actor_user_id: '10000000-0000-4000-8000-000000000201',
    automation_run_id: 'a0000000-0000-4000-8000-000000000201',
    content_version_id: '80000000-0000-4000-8000-000000000201',
    generation_run_id: '90000000-0000-4000-8000-000000000201',
    package_id: '60000000-0000-4000-8000-000000000201',
    project_id: '40000000-0000-4000-8000-000000000201',
    request_id: 'official-rewrite-201',
    rewrite_attempt: 3,
    variant_id: VARIANT_ID,
    workspace_id: '30000000-0000-4000-8000-000000000201',
  },
  event_id: 'b0000000-0000-4000-8000-000000000201',
  event_type: 'content.variant.official_site_rewrite_requested.v1',
  occurred_at: '2026-07-23T00:00:00.000Z',
  tenant: { id: '20000000-0000-4000-8000-000000000201' },
} as const;

const POLICY: OfficialSiteAutomationPolicy = {
  accountId: 'c0000000-0000-4000-8000-000000000201',
  brandConsistencyMin: 90,
  createdBy: EVENT.data.actor_user_id,
  factualAccuracyMin: 90,
  geoTotalMin: 85,
  id: 'd0000000-0000-4000-8000-000000000201',
  maxRewrites: 3,
  platformFitMin: 80,
  publishAttemptLimit: 3,
  questionCoverageMin: 80,
  readabilitySafetyMin: 85,
};

const SCORES: QualityGeoScores = {
  answerability: 92,
  entity: 92,
  evidence: 95,
  platform_fit: 90,
  question: 90,
  readability_safety: 90,
  total: 91,
};

const automation = new OfficialSiteAutomation(null as never, null as never, {
  qualityModelKey: 'deepseek-v4-pro',
  qualityPromptVersionId: '25000000-0000-4000-8000-000000000007',
  qualitySkillVersion: '1.0.0',
  rewriteModelKey: 'deepseek-v4-pro',
  writerPromptVersionId: '25000000-0000-4000-8000-000000000008',
  writerSkillVersion: '1.0.0',
});

describe('official-site automation', () => {
  it('passes only when every frozen score threshold and the decision pass', () => {
    const result = qualityResult('pass', []);
    expect(automation.calculateGate(POLICY, result, SCORES)).toEqual({
      blocking_rules: [],
      brand_consistency: 100,
      factual_accuracy: 95,
      geo_total: 91,
      passed: true,
      platform_fit: 90,
      question_coverage: 90,
      readability_safety: 90,
      schema_version: 'official-site-quality-gate@1',
    });
  });

  it('blocks every below-threshold score and any blocking issue', () => {
    const result = qualityResult('block', [
      {
        category: 'compliance',
        citation_ids: [],
        location: '正文',
        message: '价格没有输入依据',
        rule_id: 'facts.no_invented_price',
        severity: 'BLOCK',
        suggestion: '删除价格',
      },
      {
        category: 'brand',
        citation_ids: [],
        location: '正文',
        message: '与品牌档案不一致',
        rule_id: 'brand.profile_conflict',
        severity: 'WARN',
        suggestion: '按品牌档案改写',
      },
    ]);
    const gate = automation.calculateGate(POLICY, result, {
      ...SCORES,
      evidence: 89,
      platform_fit: 79,
      question: 79,
      readability_safety: 84,
      total: 84,
    });
    expect(gate.passed).toBe(false);
    expect(gate.blocking_rules).toEqual([
      'facts.no_invented_price',
      'gate.brand_consistency',
      'gate.factual_accuracy',
      'gate.geo_total',
      'gate.platform_fit',
      'gate.question_coverage',
      'gate.readability_safety',
      'quality.decision.block',
    ]);
  });

  it('validates an exact rewrite event and rejects extra fields or attempt four', () => {
    expect(validateOfficialSiteRewriteEvent(EVENT)).toMatchObject({
      data: { rewriteAttempt: 3, variantId: VARIANT_ID },
      tenantId: EVENT.tenant.id,
    });
    expect(() =>
      validateOfficialSiteRewriteEvent({
        ...EVENT,
        data: { ...EVENT.data, rewrite_attempt: 4 },
      }),
    ).toThrow(GenerationWorkerError);
    expect(() =>
      validateOfficialSiteRewriteEvent({
        ...EVENT,
        data: { ...EVENT.data, tenant_id: EVENT.tenant.id },
      }),
    ).toThrow('Official-site rewrite event is invalid');
  });
});

function qualityResult(
  decision: QualityCheckerData['decision'],
  issues: QualityCheckerData['issues'],
): QualityCheckerData {
  return { decision, geo_scores: SCORES, issues, score: SCORES.total };
}
