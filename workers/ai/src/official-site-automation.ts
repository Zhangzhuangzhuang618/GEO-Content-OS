import {
  DomainEventEnvelopeSchema,
  type AggregateType,
  type EventType,
} from '@geo-content-os/contracts';
import type {
  QualityCheckerData,
  QualityGeoScores,
  QualityIssue,
} from '@geo-content-os/contracts/skills';
import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import type { OfficialSiteAutomationConfig } from './config.js';
import { contentHash, validateGeneratedContent } from './generation.content.js';
import { insertGeneratedVersion } from './generation.store.js';
import type {
  ContentWriterRunContext,
  GeneratedContent,
  JsonObject,
  ValidatedGenerationEvent,
} from './generation.types.js';
import {
  validateOfficialSiteRewriteEvent,
  type ValidatedOfficialSiteRewriteEvent,
} from './official-site-rewrite.event.js';
import type { ValidatedQualityEvent } from './quality.event.js';
import type { RuntimeContentWriter } from './runtime-content-writer.js';

export interface OfficialSiteQualityGate {
  readonly blocking_rules: readonly string[];
  readonly brand_consistency: number;
  readonly factual_accuracy: number;
  readonly geo_total: number;
  readonly passed: boolean;
  readonly platform_fit: number;
  readonly question_coverage: number;
  readonly readability_safety: number;
  readonly schema_version: 'official-site-quality-gate@1';
}

export interface OfficialSiteAutomationPolicy {
  readonly accountId: string;
  readonly brandConsistencyMin: number;
  readonly createdBy: string;
  readonly factualAccuracyMin: number;
  readonly geoTotalMin: number;
  readonly id: string;
  readonly maxRewrites: number;
  readonly platformFitMin: number;
  readonly publishAttemptLimit: number;
  readonly questionCoverageMin: number;
  readonly readabilitySafetyMin: number;
}

interface RewriteClaim {
  readonly actorUserId: string;
  readonly automationVersion: number;
  readonly content: GeneratedContent;
  readonly contentHash: string;
  readonly issues: readonly string[];
  readonly masterContent: GeneratedContent;
  readonly modelKey: string;
  readonly packageId: string;
  readonly projectId: string;
  readonly promptVersionId: string;
  readonly runVersion: number;
  readonly skillVersion: string;
  readonly variantVersion: number;
  readonly workspaceId: string;
  readonly writerInput: JsonObject;
}

interface QualityQueueInput {
  readonly actorUserId: string;
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly packageId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly variantId: string;
  readonly workspaceId: string;
}

type AutomationSql = postgres.Sql | postgres.TransactionSql;

export class OfficialSiteAutomation {
  public constructor(
    private readonly client: postgres.Sql,
    private readonly writer: RuntimeContentWriter,
    private readonly config: OfficialSiteAutomationConfig,
  ) {}

  public async queueQualityAfterGeneration(
    transaction: postgres.TransactionSql,
    event: ValidatedGenerationEvent,
    variantId: string,
    contentVersionId: string,
    generatedHash: string,
  ): Promise<void> {
    const policy = await this.loadPolicy(transaction, event.tenantId, variantId, true);
    if (!policy) return;
    const existing = await transaction<
      { contentVersionId: string; rewriteCount: number; status: string }[]
    >`
      SELECT content_version_id AS "contentVersionId", rewrite_count AS "rewriteCount", status
      FROM official_site_automation_runs
      WHERE tenant_id=${event.tenantId}::uuid AND variant_id=${variantId}::uuid
      FOR UPDATE
    `;
    const previous = existing[0];
    if (previous?.contentVersionId === contentVersionId && previous.status === 'quality_pending') {
      return;
    }
    const continuingRewrite = previous?.status === 'rewriting';
    await transaction`
      INSERT INTO official_site_automation_runs (
        tenant_id, policy_id, variant_id, content_version_id, status, rewrite_count
      ) VALUES (
        ${event.tenantId}::uuid, ${policy.id}::uuid, ${variantId}::uuid,
        ${contentVersionId}::uuid, 'quality_pending', 0
      )
      ON CONFLICT (tenant_id, variant_id) DO UPDATE SET
        policy_id=EXCLUDED.policy_id,
        content_version_id=EXCLUDED.content_version_id,
        status='quality_pending',
        rewrite_count=${continuingRewrite ? (previous?.rewriteCount ?? 0) : 0},
        last_quality_report_id=NULL,
        publish_job_id=NULL,
        last_error_json=NULL,
        finished_at=NULL,
        version=official_site_automation_runs.version+1
    `;
    await transaction`
      UPDATE official_site_daily_batch_items SET
        status='quality_check',content_version_id=${contentVersionId}::uuid,
        last_error_json=NULL
      WHERE tenant_id=${event.tenantId}::uuid AND variant_id=${variantId}::uuid
        AND status IN ('generating','rewriting','quality_check')
    `;
    await this.enqueueQuality(transaction, {
      actorUserId: event.data.actorUserId,
      contentHash: generatedHash,
      contentVersionId,
      packageId: event.data.packageId,
      projectId: event.data.projectId,
      requestId: boundedRequestId(`auto-quality-${event.eventId}`),
      tenantId: event.tenantId,
      variantId,
      workspaceId: event.data.workspaceId,
    });
  }

  public loadGatePolicy(
    transaction: AutomationSql,
    tenantId: string,
    variantId: string,
  ): Promise<OfficialSiteAutomationPolicy | null> {
    return this.loadPolicy(transaction, tenantId, variantId, false);
  }

  public calculateGate(
    policy: OfficialSiteAutomationPolicy,
    result: QualityCheckerData,
    geoScores: QualityGeoScores,
  ): OfficialSiteQualityGate {
    const blockingRules = new Set(
      result.issues.filter((issue) => issue.severity === 'BLOCK').map((issue) => issue.rule_id),
    );
    const factualAccuracy = issueScore(result.issues, 'fact', geoScores.evidence);
    const brandConsistency = issueScore(result.issues, 'brand', 100);
    const values = {
      brand_consistency: brandConsistency,
      factual_accuracy: factualAccuracy,
      geo_total: geoScores.total,
      platform_fit: geoScores.platform_fit,
      question_coverage: geoScores.question,
      readability_safety: geoScores.readability_safety,
    };
    addThresholdFailure(blockingRules, 'gate.geo_total', values.geo_total, policy.geoTotalMin);
    addThresholdFailure(
      blockingRules,
      'gate.factual_accuracy',
      values.factual_accuracy,
      policy.factualAccuracyMin,
    );
    addThresholdFailure(
      blockingRules,
      'gate.brand_consistency',
      values.brand_consistency,
      policy.brandConsistencyMin,
    );
    addThresholdFailure(
      blockingRules,
      'gate.readability_safety',
      values.readability_safety,
      policy.readabilitySafetyMin,
    );
    addThresholdFailure(
      blockingRules,
      'gate.question_coverage',
      values.question_coverage,
      policy.questionCoverageMin,
    );
    addThresholdFailure(
      blockingRules,
      'gate.platform_fit',
      values.platform_fit,
      policy.platformFitMin,
    );
    if (result.decision !== 'pass') blockingRules.add(`quality.decision.${result.decision}`);
    return Object.freeze({
      blocking_rules: Object.freeze([...blockingRules].sort()),
      ...values,
      passed: blockingRules.size === 0,
      schema_version: 'official-site-quality-gate@1',
    });
  }

  public async failQualityExecution(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    error: unknown,
  ): Promise<void> {
    const message = (
      error instanceof Error ? error.message : 'Automated quality check failed'
    ).slice(0, 2_000);
    await transaction`
      UPDATE official_site_automation_runs SET
        status='manual_required',
        last_error_json=${JSON.stringify({
          code: 'QUALITY_CHECK_EXECUTION_FAILED',
          message,
          schema_version: 'official-site-automation-error@1',
        })}::text::jsonb,
        finished_at=now(),
        version=version+1
      WHERE tenant_id=${event.tenantId}::uuid
        AND variant_id=${event.data.variantId}::uuid
        AND content_version_id=${event.data.contentVersionId}::uuid
        AND status='quality_pending'
    `;
    await transaction`
      UPDATE official_site_daily_batch_items SET
        status='retired',
        last_error_json=${JSON.stringify({
          code: 'QUALITY_CHECK_EXECUTION_FAILED',
          message: '机器质检连续执行失败，系统将创建新候选补位。',
          schema_version: 'official-site-daily-error@1',
        })}::text::jsonb
      WHERE tenant_id=${event.tenantId}::uuid
        AND variant_id=${event.data.variantId}::uuid
        AND content_version_id=${event.data.contentVersionId}::uuid
        AND status='quality_check'
    `;
  }

  public async advanceAfterQuality(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    policy: OfficialSiteAutomationPolicy,
    reportId: string,
    gate: OfficialSiteQualityGate,
    result: QualityCheckerData,
  ): Promise<void> {
    const rows = await transaction<{ id: string; rewriteCount: number; version: number }[]>`
      SELECT id, rewrite_count AS "rewriteCount", version
      FROM official_site_automation_runs
      WHERE tenant_id=${event.tenantId}::uuid
        AND policy_id=${policy.id}::uuid
        AND variant_id=${event.data.variantId}::uuid
        AND content_version_id=${event.data.contentVersionId}::uuid
        AND status='quality_pending'
      FOR UPDATE
    `;
    const automationRun = rows[0];
    if (!automationRun) return;
    if (gate.passed) {
      if (await this.holdDailyQualified(transaction, event, automationRun, reportId)) {
        return;
      }
      await this.schedulePublication(transaction, event, policy, automationRun, reportId);
      return;
    }
    if (automationRun.rewriteCount >= policy.maxRewrites) {
      await transaction`
        UPDATE official_site_automation_runs SET
          status='manual_required', last_quality_report_id=${reportId}::uuid,
          last_error_json=${JSON.stringify({
            blocking_rules: gate.blocking_rules,
            code: 'QUALITY_GATE_FAILED_AFTER_MAX_REWRITES',
            schema_version: 'official-site-automation-error@1',
          })}::text::jsonb,
          finished_at=now(), version=version+1
        WHERE id=${automationRun.id}::uuid AND tenant_id=${event.tenantId}::uuid
          AND version=${automationRun.version}
      `;
      await transaction`
        UPDATE official_site_daily_batch_items SET
          status='retired',
          last_error_json=${JSON.stringify({
            blocking_rules: gate.blocking_rules,
            code: 'QUALITY_GATE_FAILED_AFTER_MAX_REWRITES',
            message: '连续 3 次重写仍未通过质量门禁，系统将创建新候选补位。',
            schema_version: 'official-site-daily-error@1',
          })}::text::jsonb
        WHERE tenant_id=${event.tenantId}::uuid
          AND variant_id=${event.data.variantId}::uuid
          AND status IN ('quality_check','rewriting')
      `;
      return;
    }
    await this.enqueueRewrite(
      transaction,
      event,
      automationRun,
      reportId,
      policy,
      gate,
      result.issues,
    );
  }

  public async runRewrite(
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<{ readonly disposition: 'completed' | 'processed' }> {
    const event = validateOfficialSiteRewriteEvent(raw);
    const claim = await this.claimRewrite(event);
    if (!claim) return { disposition: 'completed' };
    try {
      const rewritten = await this.writer.rewriteOfficialSiteVariant({
        context: rewriteContext(event, claim),
        currentContent: claim.content,
        issues: claim.issues,
        masterContent: claim.masterContent,
        requestId: `official-rewrite-${event.eventId}`,
        ...(signal ? { signal } : {}),
        writerInput: claim.writerInput,
      });
      await this.saveRewrite(event, claim, rewritten);
      return { disposition: 'processed' };
    } catch (error) {
      const terminal = await this.releaseFailedRewrite(event, claim, error);
      if (terminal) return { disposition: 'processed' };
      throw error;
    }
  }

  private async loadPolicy(
    client: AutomationSql,
    tenantId: string,
    variantId: string,
    lock: boolean,
  ): Promise<OfficialSiteAutomationPolicy | null> {
    const rows = await client<OfficialSiteAutomationPolicy[]>`
      SELECT
        policy.id, policy.account_id AS "accountId", policy.created_by AS "createdBy",
        policy.geo_total_min AS "geoTotalMin",
        policy.factual_accuracy_min AS "factualAccuracyMin",
        policy.brand_consistency_min AS "brandConsistencyMin",
        policy.readability_safety_min AS "readabilitySafetyMin",
        policy.question_coverage_min AS "questionCoverageMin",
        policy.platform_fit_min AS "platformFitMin",
        policy.max_rewrites AS "maxRewrites",
        policy.publish_attempt_limit AS "publishAttemptLimit"
      FROM official_site_automation_policies AS policy
      JOIN content_packages AS package
        ON package.project_id=policy.project_id AND package.tenant_id=policy.tenant_id
        AND package.workspace_id=policy.workspace_id AND package.deleted_at IS NULL
      JOIN content_variants AS variant
        ON variant.package_id=package.id AND variant.tenant_id=package.tenant_id
        AND variant.id=${variantId}::uuid AND variant.platform_code='official_site'
        AND variant.platform_account_id=policy.account_id
      JOIN platform_accounts AS account
        ON account.id=policy.account_id AND account.tenant_id=policy.tenant_id
        AND account.workspace_id=policy.workspace_id AND account.platform_code='official_site'
        AND account.status='active' AND account.publish_mode='api' AND account.deleted_at IS NULL
      WHERE policy.tenant_id=${tenantId}::uuid AND policy.enabled
      LIMIT 1
      ${lock ? client`FOR UPDATE OF policy` : client``}
    `;
    return rows[0] ?? null;
  }

  private async enqueueQuality(
    transaction: postgres.TransactionSql,
    input: QualityQueueInput,
  ): Promise<void> {
    const runs = await transaction<{ id: string }[]>`
      INSERT INTO generation_runs (
        tenant_id, workspace_id, project_id, package_id, variant_id,
        skill_name, skill_version, prompt_version_id, model_key, input_hash, request_id
      ) VALUES (
        ${input.tenantId}::uuid, ${input.workspaceId}::uuid, ${input.projectId}::uuid,
        ${input.packageId}::uuid, ${input.variantId}::uuid, 'quality-checker',
        ${this.config.qualitySkillVersion}, ${this.config.qualityPromptVersionId}::uuid,
        ${this.config.qualityModelKey}, ${input.contentHash}, ${input.requestId}
      )
      RETURNING id
    `;
    const generationRunId = runs[0]?.id;
    if (!generationRunId) throw new Error('Automation quality run insert failed');
    const event = createEvent(
      input.tenantId,
      'content.variant.quality_check_requested.v1',
      'content_variant',
      input.variantId,
      {
        actor_user_id: input.actorUserId,
        content_hash: input.contentHash,
        content_version_id: input.contentVersionId,
        generation_run_id: generationRunId,
        package_id: input.packageId,
        project_id: input.projectId,
        request_id: input.requestId,
        variant_id: input.variantId,
        workspace_id: input.workspaceId,
      },
    );
    await insertOutbox(transaction, event);
  }

  private async enqueueRewrite(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    automationRun: { readonly id: string; readonly rewriteCount: number; readonly version: number },
    reportId: string,
    policy: OfficialSiteAutomationPolicy,
    gate: OfficialSiteQualityGate,
    issues: readonly QualityIssue[],
  ): Promise<void> {
    const attempt = automationRun.rewriteCount + 1;
    const promptIssueText = buildOfficialSiteRewriteDiagnostics(policy, gate, issues);
    const inputHash = sha256(
      JSON.stringify({
        attempt,
        content_version_id: event.data.contentVersionId,
        issues: promptIssueText,
      }),
    );
    const runs = await transaction<{ id: string }[]>`
      INSERT INTO generation_runs (
        tenant_id, workspace_id, project_id, package_id, variant_id,
        skill_name, skill_version, prompt_version_id, model_key, input_hash, request_id
      ) VALUES (
        ${event.tenantId}::uuid, ${event.data.workspaceId}::uuid,
        ${event.data.projectId}::uuid, ${event.data.packageId}::uuid,
        ${event.data.variantId}::uuid, 'content-writer', ${this.config.writerSkillVersion},
        ${this.config.writerPromptVersionId}::uuid, ${this.config.rewriteModelKey},
        ${inputHash}, ${boundedRequestId(`official-rewrite-${automationRun.id}-${attempt}`)}
      )
      RETURNING id
    `;
    const generationRunId = runs[0]?.id;
    if (!generationRunId) throw new Error('Automation rewrite run insert failed');
    const changed = await transaction<{ id: string }[]>`
      UPDATE official_site_automation_runs SET
        status='rewrite_pending', rewrite_count=${attempt},
        last_quality_report_id=${reportId}::uuid,
        last_error_json=${JSON.stringify({
          blocking_rules: gate.blocking_rules,
          prompt_issues: promptIssueText,
          schema_version: 'official-site-automation-error@1',
          worker_failures: 0,
        })}::text::jsonb,
        version=version+1
      WHERE id=${automationRun.id}::uuid AND tenant_id=${event.tenantId}::uuid
        AND version=${automationRun.version}
      RETURNING id
    `;
    if (changed.length !== 1) throw new Error('Automation run lease was lost');
    await transaction`
      UPDATE official_site_daily_batch_items SET status='rewriting'
      WHERE tenant_id=${event.tenantId}::uuid
        AND variant_id=${event.data.variantId}::uuid
        AND status='quality_check'
    `;
    const rewriteEvent = createEvent(
      event.tenantId,
      'content.variant.official_site_rewrite_requested.v1',
      'content_variant',
      event.data.variantId,
      {
        actor_user_id: event.data.actorUserId,
        automation_run_id: automationRun.id,
        content_version_id: event.data.contentVersionId,
        generation_run_id: generationRunId,
        package_id: event.data.packageId,
        project_id: event.data.projectId,
        request_id: boundedRequestId(`official-rewrite-${automationRun.id}-${attempt}`),
        rewrite_attempt: attempt,
        variant_id: event.data.variantId,
        workspace_id: event.data.workspaceId,
      },
    );
    await insertOutbox(transaction, rewriteEvent);
  }

  private async holdDailyQualified(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    automationRun: { readonly id: string; readonly version: number },
    reportId: string,
  ): Promise<boolean> {
    const items = await transaction<{ id: string }[]>`
      UPDATE official_site_daily_batch_items SET
        status='qualified',content_version_id=${event.data.contentVersionId}::uuid,
        qualified_at=now(),last_error_json=NULL
      WHERE tenant_id=${event.tenantId}::uuid
        AND variant_id=${event.data.variantId}::uuid
        AND status='quality_check'
      RETURNING id
    `;
    if (items.length === 0) return false;
    const runs = await transaction<{ id: string }[]>`
      UPDATE official_site_automation_runs SET
        status='publish_pending',last_quality_report_id=${reportId}::uuid,
        last_error_json=NULL,version=version+1
      WHERE id=${automationRun.id}::uuid AND tenant_id=${event.tenantId}::uuid
        AND status='quality_pending' AND version=${automationRun.version}
      RETURNING id
    `;
    if (runs.length !== 1) throw new Error('Daily automation run lease was lost');
    return true;
  }

  private async schedulePublication(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    policy: OfficialSiteAutomationPolicy,
    automationRun: { readonly id: string; readonly version: number },
    reportId: string,
  ): Promise<void> {
    const idempotencyKey = `official-site:${event.data.variantId}:${event.data.contentVersionId}`;
    const jobs = await transaction<{ id: string; version: number }[]>`
      INSERT INTO publish_jobs (
        tenant_id, variant_id, content_version_id, account_id, scheduled_at,
        idempotency_key, payload_hash, status, created_by, origin
      ) VALUES (
        ${event.tenantId}::uuid, ${event.data.variantId}::uuid,
        ${event.data.contentVersionId}::uuid, ${policy.accountId}::uuid, now(),
        ${idempotencyKey}, ${event.data.contentHash}, 'scheduled',
        ${policy.createdBy}::uuid, 'official_site_automation'
      )
      ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
        idempotency_key=EXCLUDED.idempotency_key
      RETURNING id, version
    `;
    const job = jobs[0];
    if (!job) throw new Error('Automation publish job insert failed');
    const variants = await transaction<{ id: string }[]>`
      UPDATE content_variants SET status='scheduled', version=version+1
      WHERE tenant_id=${event.tenantId}::uuid AND id=${event.data.variantId}::uuid
        AND current_content_version_id=${event.data.contentVersionId}::uuid
        AND status='quality_passed'
      RETURNING id
    `;
    if (variants.length !== 1) throw new Error('Automation variant is not ready to publish');
    const changed = await transaction<{ id: string }[]>`
      UPDATE official_site_automation_runs SET
        status='publishing', last_quality_report_id=${reportId}::uuid,
        publish_job_id=${job.id}::uuid, last_error_json=NULL, version=version+1
      WHERE id=${automationRun.id}::uuid AND tenant_id=${event.tenantId}::uuid
        AND version=${automationRun.version}
      RETURNING id
    `;
    if (changed.length !== 1) throw new Error('Automation run lease was lost');
    const publishEvent = createEvent(
      event.tenantId,
      'publishing.job.execution_requested.v1',
      'publish_job',
      job.id,
      {
        job_id: job.id,
        job_version: job.version,
        request_id: boundedRequestId(`official-publish-${automationRun.id}`),
        scheduled_at: new Date().toISOString(),
      },
    );
    await insertOutbox(transaction, publishEvent);
  }

  private claimRewrite(event: ValidatedOfficialSiteRewriteEvent): Promise<RewriteClaim | null> {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<
        {
          actorUserId: string;
          automationError: unknown;
          automationVersion: number;
          content: unknown;
          contentHash: string;
          masterContent: unknown;
          modelKey: string;
          packageId: string;
          projectId: string;
          promptVersionId: string;
          runStatus: string;
          runVersion: number;
          skillVersion: string;
          variantStatus: string;
          variantVersion: number;
          workspaceId: string;
          writerInput: unknown;
        }[]
      >`
        SELECT
          policy.created_by AS "actorUserId", automation.version AS "automationVersion",
          automation.last_error_json AS "automationError",
          current.content_json AS content, current.content_hash AS "contentHash",
          master.content_json AS "masterContent", generation.model_key AS "modelKey",
          package.id AS "packageId", package.project_id AS "projectId",
          generation.prompt_version_id AS "promptVersionId", generation.status AS "runStatus",
          generation.version AS "runVersion", generation.skill_version AS "skillVersion",
          variant.status AS "variantStatus", variant.version AS "variantVersion",
          package.workspace_id AS "workspaceId",
          source_event.payload_json->'data'->'writer_input' AS "writerInput"
        FROM official_site_automation_runs AS automation
        JOIN official_site_automation_policies AS policy
          ON policy.id=automation.policy_id AND policy.tenant_id=automation.tenant_id
        JOIN content_variants AS variant
          ON variant.id=automation.variant_id AND variant.tenant_id=automation.tenant_id
        JOIN content_packages AS package
          ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
        JOIN content_versions AS current
          ON current.id=automation.content_version_id AND current.tenant_id=automation.tenant_id
        JOIN content_versions AS master
          ON master.id=package.master_content_version_id AND master.tenant_id=package.tenant_id
        JOIN generation_runs AS generation
          ON generation.id=${event.data.generationRunId}::uuid
          AND generation.tenant_id=automation.tenant_id
          AND generation.variant_id=automation.variant_id
        JOIN LATERAL (
          SELECT payload_json
          FROM outbox_events
          WHERE tenant_id=automation.tenant_id
            AND event_type='content.package.generation_requested.v1'
            AND payload_json->'data'->'variant_runs' @>
              ${JSON.stringify([{ variant_id: event.data.variantId }])}::text::jsonb
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) AS source_event ON true
        WHERE automation.id=${event.data.automationRunId}::uuid
          AND automation.tenant_id=${event.tenantId}::uuid
          AND automation.content_version_id=${event.data.contentVersionId}::uuid
          AND automation.rewrite_count=${event.data.rewriteAttempt}
          AND automation.status='rewrite_pending'
          AND generation.status='queued'
          AND generation.package_id=${event.data.packageId}::uuid
          AND generation.project_id=${event.data.projectId}::uuid
          AND generation.workspace_id=${event.data.workspaceId}::uuid
          AND variant.current_content_version_id=current.id
          AND variant.platform_code='official_site'
          AND variant.status='quality_failed'
          AND policy.enabled
        FOR UPDATE OF automation, generation, variant
      `;
      const row = rows[0];
      if (!row) return null;
      const writerInput = buildOfficialSiteRewriteInput(row.writerInput);
      const issues = extractOfficialSiteRewriteIssues(row.automationError);
      const generation = await transaction<{ version: number }[]>`
        UPDATE generation_runs SET status='running', started_at=COALESCE(started_at,now()),
          finished_at=NULL, error_json=NULL, version=version+1
        WHERE id=${event.data.generationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='queued' AND version=${row.runVersion}
        RETURNING version
      `;
      const run = generation[0];
      if (!run) throw new Error('Rewrite generation run lease was lost');
      const variants = await transaction<{ version: number }[]>`
        UPDATE content_variants SET status='generating', version=version+1
        WHERE id=${event.data.variantId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='quality_failed' AND version=${row.variantVersion}
        RETURNING version
      `;
      const variant = variants[0];
      if (!variant) throw new Error('Rewrite variant lease was lost');
      const automations = await transaction<{ version: number }[]>`
        UPDATE official_site_automation_runs SET status='rewriting', version=version+1
        WHERE id=${event.data.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='rewrite_pending' AND version=${row.automationVersion}
        RETURNING version
      `;
      const automation = automations[0];
      if (!automation) throw new Error('Automation run lease was lost');
      return Object.freeze({
        actorUserId: row.actorUserId,
        automationVersion: automation.version,
        content: validateGeneratedContent(row.content, 'official_site'),
        contentHash: row.contentHash,
        issues,
        masterContent: validateGeneratedContent(row.masterContent, 'master'),
        modelKey: row.modelKey,
        packageId: row.packageId,
        projectId: row.projectId,
        promptVersionId: row.promptVersionId,
        runVersion: run.version,
        skillVersion: row.skillVersion,
        variantVersion: variant.version,
        workspaceId: row.workspaceId,
        writerInput,
      });
    });
  }

  private async saveRewrite(
    event: ValidatedOfficialSiteRewriteEvent,
    claim: RewriteClaim,
    rewritten: GeneratedContent,
  ): Promise<void> {
    await this.client.begin(async (transaction) => {
      const synthetic = generationEventForRewrite(event, claim);
      const versionId = await insertGeneratedVersion(
        transaction,
        synthetic,
        event.data.variantId,
        event.data.generationRunId,
        rewritten,
      );
      const rewrittenHash = contentHash(rewritten);
      const variants = await transaction<{ id: string }[]>`
        UPDATE content_variants SET current_content_version_id=${versionId}::uuid,
          status='generated', quality_score=NULL, version=version+1
        WHERE id=${event.data.variantId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND current_content_version_id=${event.data.contentVersionId}::uuid
          AND status='generating' AND version=${claim.variantVersion}
        RETURNING id
      `;
      if (variants.length !== 1) throw new Error('Rewritten content is no longer current');
      const runs = await transaction<{ id: string }[]>`
        UPDATE generation_runs SET status='succeeded', finished_at=now(), error_json=NULL,
          version=version+1
        WHERE id=${event.data.generationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='running' AND version=${claim.runVersion}
        RETURNING id
      `;
      if (runs.length !== 1) throw new Error('Rewrite generation run lease was lost');
      const automations = await transaction<{ id: string }[]>`
        UPDATE official_site_automation_runs SET content_version_id=${versionId}::uuid,
          status='quality_pending', last_error_json=NULL, version=version+1
        WHERE id=${event.data.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='rewriting' AND version=${claim.automationVersion}
        RETURNING id
      `;
      if (automations.length !== 1) throw new Error('Automation run lease was lost');
      await transaction`
        UPDATE official_site_daily_batch_items SET
          status='quality_check',content_version_id=${versionId}::uuid,
          last_error_json=NULL
        WHERE tenant_id=${event.tenantId}::uuid
          AND variant_id=${event.data.variantId}::uuid
          AND status='rewriting'
      `;
      await this.enqueueQuality(transaction, {
        actorUserId: claim.actorUserId,
        contentHash: rewrittenHash,
        contentVersionId: versionId,
        packageId: event.data.packageId,
        projectId: event.data.projectId,
        requestId: boundedRequestId(`auto-quality-${event.eventId}`),
        tenantId: event.tenantId,
        variantId: event.data.variantId,
        workspaceId: event.data.workspaceId,
      });
      await transaction`
        INSERT INTO audit_events (
          tenant_id, actor_id, action, resource_type, resource_id,
          before_json, after_json, request_id
        ) VALUES (
          ${event.tenantId}::uuid, ${claim.actorUserId}::uuid,
          'content.variant.official_site_auto_rewritten', 'content_variant',
          ${event.data.variantId}::uuid,
          ${JSON.stringify({ content_version_id: event.data.contentVersionId })}::text::jsonb,
          ${JSON.stringify({
            content_version_id: versionId,
            rewrite_attempt: event.data.rewriteAttempt,
          })}::text::jsonb,
          ${event.data.requestId}
        )
      `;
    });
  }

  private releaseFailedRewrite(
    event: ValidatedOfficialSiteRewriteEvent,
    claim: RewriteClaim,
    error: unknown,
  ): Promise<boolean> {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<{ lastError: unknown }[]>`
        SELECT last_error_json AS "lastError"
        FROM official_site_automation_runs
        WHERE id=${event.data.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='rewriting' AND version=${claim.automationVersion}
        FOR UPDATE
      `;
      const previousError = record(rows[0]?.lastError) ? rows[0].lastError : {};
      const previousFailures = Number(previousError['worker_failures']);
      const failures = Number.isSafeInteger(previousFailures) ? previousFailures + 1 : 1;
      const terminal = failures >= 3;
      await transaction`
        UPDATE generation_runs SET status=${terminal ? 'failed' : 'queued'},
          error_json=${JSON.stringify({
            code: 'OFFICIAL_SITE_REWRITE_FAILED',
            message: safeError(error),
          })}::text::jsonb,
          started_at=${terminal ? transaction`started_at` : transaction`NULL`},
          finished_at=${terminal ? transaction`now()` : transaction`NULL`},
          version=version+1
        WHERE id=${event.data.generationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='running' AND version=${claim.runVersion}
      `;
      await transaction`
        UPDATE content_variants SET status='quality_failed', version=version+1
        WHERE id=${event.data.variantId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='generating' AND version=${claim.variantVersion}
      `;
      await transaction`
        UPDATE official_site_automation_runs SET
          status=${terminal ? 'manual_required' : 'rewrite_pending'},
          last_error_json=${JSON.stringify({
            blocking_rules: arrayOfStrings(previousError['blocking_rules']),
            code: terminal ? 'REWRITE_EXECUTION_FAILED' : 'REWRITE_EXECUTION_RETRY',
            message: safeError(error),
            prompt_issues: arrayOfStrings(previousError['prompt_issues']),
            schema_version: 'official-site-automation-error@1',
            worker_failures: failures,
          })}::text::jsonb,
          finished_at=${terminal ? transaction`now()` : transaction`NULL`},
          version=version+1
        WHERE id=${event.data.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='rewriting' AND version=${claim.automationVersion}
      `;
      if (terminal) {
        await transaction`
          UPDATE official_site_daily_batch_items SET
            status='retired',
            last_error_json=${JSON.stringify({
              code: 'REWRITE_EXECUTION_FAILED',
              message: safeError(error),
              schema_version: 'official-site-daily-error@1',
            })}::text::jsonb
          WHERE tenant_id=${event.tenantId}::uuid
            AND variant_id=${event.data.variantId}::uuid
            AND status='rewriting'
        `;
      }
      return terminal;
    });
  }
}

function issueScore(
  issues: readonly QualityIssue[],
  category: QualityIssue['category'],
  baseline: number,
): number {
  let score = baseline;
  for (const issue of issues.filter((candidate) => candidate.category === category)) {
    score -= issue.severity === 'BLOCK' ? 100 : issue.severity === 'WARN' ? 15 : 2;
  }
  return Math.max(0, Math.min(100, score));
}

function addThresholdFailure(
  rules: Set<string>,
  rule: string,
  score: number,
  minimum: number,
): void {
  if (score < minimum) rules.add(rule);
}

function createEvent(
  tenantId: string,
  eventType: EventType,
  aggregateType: AggregateType,
  aggregateId: string,
  data: Readonly<Record<string, unknown>>,
) {
  return DomainEventEnvelopeSchema.parse({
    aggregate: { id: aggregateId, type: aggregateType },
    data,
    event_id: randomUUID(),
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    tenant: { id: tenantId },
  });
}

async function insertOutbox(
  transaction: postgres.TransactionSql,
  event: ReturnType<typeof createEvent>,
): Promise<void> {
  await transaction`
    INSERT INTO outbox_events (
      id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json
    ) VALUES (
      ${event.event_id}::uuid, ${event.tenant.id}::uuid, ${event.event_type},
      ${event.aggregate.type}, ${event.aggregate.id}::uuid,
      ${JSON.stringify(event)}::text::jsonb
    )
  `;
}

export function buildOfficialSiteRewriteInput(value: unknown): JsonObject {
  if (!record(value)) throw new Error('Original Content Writer input is missing');
  const brief = record(value['brief']) ? value['brief'] : {};
  const rules = record(value['platform_rules_by_code']) ? value['platform_rules_by_code'] : {};
  const officialRules = rules['official_site'];
  if (!record(officialRules)) throw new Error('Official-site platform rules are missing');
  const strategy = record(value['strategy']) ? value['strategy'] : {};
  const citations = Array.isArray(value['citations']) ? value['citations'] : [];
  const locked = Array.isArray(value['locked_blocks'])
    ? value['locked_blocks'].filter(
        (item) =>
          record(item) &&
          (item['platform_code'] === 'master' || item['platform_code'] === 'official_site'),
      )
    : [];
  return {
    brief: { ...(brief as JsonObject), platform_codes: ['official_site'] },
    citations: citations as JsonObject[],
    generation_mode: 'rewrite',
    locked_blocks: locked as JsonObject[],
    platform_rules_by_code: { official_site: officialRules as JsonObject },
    strategy: strategy as JsonObject,
  };
}

export function extractOfficialSiteRewriteIssues(automationError: unknown): readonly string[] {
  const error = record(automationError) ? automationError : {};
  const issues = Array.isArray(error['prompt_issues']) ? error['prompt_issues'] : [];
  return issues.filter((value): value is string => typeof value === 'string').slice(0, 50);
}

export function buildOfficialSiteRewriteDiagnostics(
  policy: OfficialSiteAutomationPolicy,
  gate: OfficialSiteQualityGate,
  issues: readonly QualityIssue[],
): readonly string[] {
  const issueDiagnostics = issues.map((issue) =>
    [
      `质量问题 ${issue.severity} ${issue.rule_id}`,
      `位置：${issue.location ?? '未指定'}`,
      `问题：${issue.message}`,
      issue.suggestion ? `修改建议：${issue.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('；'),
  );
  const gateDiagnostics = gate.blocking_rules.map((rule) =>
    officialSiteGateRewriteDiagnostic(rule, policy, gate),
  );
  return Object.freeze([...issueDiagnostics, ...gateDiagnostics].slice(0, 50));
}

function officialSiteGateRewriteDiagnostic(
  rule: string,
  policy: OfficialSiteAutomationPolicy,
  gate: OfficialSiteQualityGate,
): string {
  if (rule === 'gate.factual_accuracy') {
    return `门禁 gate.factual_accuracy：当前 ${gate.factual_accuracy}，最低要求 ${policy.factualAccuracyMin}。定位质量问题指定的 block_key，删除引用不能直接支持的事实；一个带引用的正文块只保留该引用能够直接支持的声明，通用建议应拆成不带引用的独立段落。`;
  }
  if (rule === 'gate.question_coverage') {
    return `门禁 gate.question_coverage：当前 ${gate.question_coverage}，最低要求 ${policy.questionCoverageMin}。把标题改为能够直接回答用户问题的表达，并用“如何、怎么、为什么、哪些、是否、指南、方法”或问号明确真实问题意图。`;
  }
  if (rule === 'gate.geo_total') {
    return `门禁 gate.geo_total：当前 ${gate.geo_total}，最低要求 ${policy.geoTotalMin}。先解决本次列出的事实准确性、问题覆盖、平台适配和可读性问题；不得通过重复、填充或虚构事实提高总分。`;
  }
  if (rule === 'gate.brand_consistency') {
    return `门禁 gate.brand_consistency：当前 ${gate.brand_consistency}，最低要求 ${policy.brandConsistencyMin}。删除与已发布品牌资料冲突或无法由品牌资料支持的企业陈述。`;
  }
  if (rule === 'gate.readability_safety') {
    return `门禁 gate.readability_safety：当前 ${gate.readability_safety}，最低要求 ${policy.readabilitySafetyMin}。补充有实质信息的正文结构和步骤，删除危险承诺，不得堆字或重复。`;
  }
  if (rule === 'gate.platform_fit') {
    return `门禁 gate.platform_fit：当前 ${gate.platform_fit}，最低要求 ${policy.platformFitMin}。确保官网标题为 20–60 个 Unicode 字符；当前阶段只重写标题、摘要和正文，FAQ 与发布技术字段由后续阶段生成。`;
  }
  if (rule.startsWith('quality.decision.')) {
    return `门禁 ${rule}：必须逐项解决所有 BLOCK/WARN 质量问题，使最终问题数组满足冻结决策规则；不得只修改表面措辞。`;
  }
  return `门禁未通过：${rule}。结合本次同名质量问题的位置和建议完成实质修改，不得删除有效引用或编造新事实。`;
}

function rewriteContext(
  event: ValidatedOfficialSiteRewriteEvent,
  claim: RewriteClaim,
): ContentWriterRunContext {
  return Object.freeze({
    batchKey: event.eventId,
    inputHash: claim.contentHash,
    modelKey: claim.modelKey,
    modelPolicy: 'quality',
    packageId: claim.packageId,
    projectId: claim.projectId,
    promptVersionId: claim.promptVersionId,
    runId: event.data.generationRunId,
    skillName: 'content-writer',
    skillVersion: claim.skillVersion,
    tenantId: event.tenantId,
    variantId: event.data.variantId,
    workspaceId: claim.workspaceId,
  });
}

function generationEventForRewrite(
  event: ValidatedOfficialSiteRewriteEvent,
  claim: RewriteClaim,
): ValidatedGenerationEvent {
  return Object.freeze({
    data: Object.freeze({
      actorUserId: claim.actorUserId,
      inputHash: claim.contentHash,
      masterRunId: event.data.generationRunId,
      modelKey: claim.modelKey,
      modelPolicy: 'quality',
      packageId: claim.packageId,
      projectId: claim.projectId,
      promptVersionId: claim.promptVersionId,
      requestId: event.data.requestId,
      skillVersion: claim.skillVersion,
      variantRuns: Object.freeze([]),
      workspaceId: claim.workspaceId,
      writerInput: claim.writerInput,
    }),
    eventId: event.eventId,
    occurredAt: new Date().toISOString(),
    tenantId: event.tenantId,
  });
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Automated rewrite failed').slice(0, 2_000);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedRequestId(value: string): string {
  return value.length <= 80 ? value : `auto-${sha256(value).slice(0, 75)}`;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayOfStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 50)
    : [];
}
