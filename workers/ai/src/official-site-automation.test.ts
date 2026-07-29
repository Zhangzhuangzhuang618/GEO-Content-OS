import {
  CONTENT_WRITER_INPUT_SCHEMA,
  type QualityCheckerData,
  type QualityGeoScores,
} from '@geo-content-os/contracts/skills';
import { CONTENT_WRITER_CONTRACT_V1 } from '@geo-content-os/skills/content-writer';
import { SchemaGuard } from '@geo-content-os/skills/runtime';
import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { GenerationWorkerError } from './generation.errors.js';
import {
  buildOfficialSiteRewriteDiagnostics,
  buildOfficialSiteRewriteInput,
  extractOfficialSiteRewriteIssues,
  OfficialSiteAutomation,
  type OfficialSiteAutomationPolicy,
} from './official-site-automation.js';
import { validateOfficialSiteRewriteEvent } from './official-site-rewrite.event.js';
import { validateQualityEvent } from './quality.event.js';

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

  it('keeps automated rewrite guidance outside the frozen Content Writer input schema', () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const xiaohongshuRule = (
      fixture.input['platform_rules_by_code'] as Readonly<Record<string, unknown>>
    )['xiaohongshu'];
    const input = {
      ...fixture.input,
      brief: {
        ...(fixture.input['brief'] as Readonly<Record<string, unknown>>),
        platform_codes: ['xiaohongshu', 'official_site'],
      },
      platform_rules_by_code: {
        official_site: xiaohongshuRule,
        xiaohongshu: xiaohongshuRule,
      },
    };
    const rewriteInput = buildOfficialSiteRewriteInput(input);
    const issues = extractOfficialSiteRewriteIssues({
      prompt_issues: ['删除无依据排名', 42, '补充问题覆盖'],
    });

    expect(new SchemaGuard().check(CONTENT_WRITER_INPUT_SCHEMA, rewriteInput)).toMatchObject({
      valid: true,
    });
    expect(rewriteInput).not.toHaveProperty('automation_rewrite');
    expect(rewriteInput['generation_mode']).toBe('rewrite');
    expect((rewriteInput['brief'] as Readonly<Record<string, unknown>>)['platform_codes']).toEqual([
      'official_site',
    ]);
    expect(issues).toEqual(['删除无依据排名', '补充问题覆盖']);
  });

  it('preserves actionable issue locations and explains frozen gate repairs', () => {
    const diagnostics = buildOfficialSiteRewriteDiagnostics(
      POLICY,
      {
        ...automation.calculateGate(POLICY, qualityResult('pass', []), SCORES),
        blocking_rules: ['gate.factual_accuracy', 'gate.question_coverage', 'gate.geo_total'],
        factual_accuracy: 55,
        geo_total: 72,
        passed: false,
        question_coverage: 72,
      },
      [
        {
          category: 'fact',
          citation_ids: [],
          location: 'claim:service-scope',
          message: '高风险事实缺少充分证据或存在冲突。',
          rule_id: 'fact.high_risk.unsupported_or_conflicted',
          severity: 'BLOCK',
          suggestion: '删除该事实，或补充能够直接支持该事实的有效证据。',
        },
      ],
    );

    expect(diagnostics[0]).toContain('位置：claim:service-scope');
    expect(diagnostics[0]).toContain('修改建议：删除该事实');
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining('当前 55，最低要求 90'),
        expect.stringContaining('一个带引用的正文块只保留该引用能够直接支持的声明'),
        expect.stringContaining('当前 72，最低要求 80'),
        expect.stringContaining('如何、怎么、为什么、哪些、是否、指南、方法'),
        expect.stringContaining('不得通过重复、填充或虚构事实提高总分'),
      ]),
    );
  });

  it('retires a daily candidate when quality execution exhausts its retries', async () => {
    const calls: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
    const transaction = ((
      strings: TemplateStringsArray,
      ...values: readonly unknown[]
    ): Promise<readonly unknown[]> => {
      calls.push({ sql: strings.join('?'), values });
      return Promise.resolve([]);
    }) as unknown as postgres.TransactionSql;
    const qualityEvent = validateQualityEvent({
      aggregate: { id: VARIANT_ID, type: 'content_variant' },
      data: {
        actor_user_id: EVENT.data.actor_user_id,
        content_hash: 'a'.repeat(64),
        content_version_id: EVENT.data.content_version_id,
        generation_run_id: EVENT.data.generation_run_id,
        package_id: EVENT.data.package_id,
        project_id: EVENT.data.project_id,
        request_id: 'quality-exhausted-201',
        variant_id: VARIANT_ID,
        workspace_id: EVENT.data.workspace_id,
      },
      event_id: 'e0000000-0000-4000-8000-000000000201',
      event_type: 'content.variant.quality_check_requested.v1',
      occurred_at: '2026-07-28T00:00:00.000Z',
      tenant: { id: EVENT.tenant.id },
    });

    await automation.failQualityExecution(
      transaction,
      qualityEvent,
      new Error('quality provider failed'),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toContain("status='manual_required'");
    expect(calls[1]!.sql).toContain("status='retired'");
    expect(JSON.stringify(calls.flatMap((call) => call.values))).toContain(
      'QUALITY_CHECK_EXECUTION_FAILED',
    );
  });
});

function qualityResult(
  decision: QualityCheckerData['decision'],
  issues: QualityCheckerData['issues'],
): QualityCheckerData {
  return { decision, geo_scores: SCORES, issues, score: SCORES.total };
}
