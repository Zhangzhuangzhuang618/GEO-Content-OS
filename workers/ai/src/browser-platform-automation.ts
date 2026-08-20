import {
  DomainEventEnvelopeSchema,
  qualityEvaluationFingerprintSource,
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

import { validateBrowserPlatformRewriteEvent } from './browser-platform-rewrite.event.js';
import type { OfficialSiteAutomationConfig } from './config.js';
import { contentHash, validateGeneratedContent } from './generation.content.js';
import { insertGeneratedVersion } from './generation.store.js';
import type {
  ContentWriterRunContext,
  GeneratedContent,
  JsonObject,
  ValidatedGenerationEvent,
} from './generation.types.js';
import type { ValidatedQualityEvent } from './quality.event.js';
import type { RuntimeContentWriter } from './runtime-content-writer.js';

type Platform = 'lieju' | 'sohu';
type AutomationSql = postgres.Sql | postgres.TransactionSql;

export interface BrowserPlatformQualityGate {
  readonly blocking_rules: readonly string[];
  readonly brand_consistency: number;
  readonly factual_accuracy: number;
  readonly geo_total: number;
  readonly passed: boolean;
  readonly platform_fit: number;
  readonly platform_code: Platform;
  readonly question_coverage: number;
  readonly readability_safety: number;
  readonly schema_version: 'browser-platform-quality-gate@1';
}

export interface BrowserPlatformAutomationPolicy {
  readonly accountId: string;
  readonly brandConsistencyMin: number;
  readonly createdBy: string;
  readonly factualAccuracyMin: number;
  readonly geoTotalMin: number;
  readonly id: string;
  readonly maxRewrites: number;
  readonly platformCode: Platform;
  readonly platformFitMin: number;
  readonly publishAttemptLimit: number;
  readonly questionCoverageMin: number;
  readonly readabilitySafetyMin: number;
  readonly scheduleTimes: readonly string[];
}

interface QualityQueueInput {
  readonly actorUserId: string;
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly generationRunId: string;
  readonly packageId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly variantId: string;
  readonly workspaceId: string;
}

export class BrowserPlatformAutomation {
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
    const rows = await transaction<
      {
        actorUserId: string;
        automationRunId: string;
        generationRunId: string;
        version: number;
      }[]
    >`
      SELECT policy.created_by AS "actorUserId",automation.id AS "automationRunId",
        generation.id AS "generationRunId",automation.version
      FROM browser_platform_automation_runs AS automation
      JOIN browser_platform_automation_policies AS policy
        ON policy.id=automation.policy_id AND policy.tenant_id=automation.tenant_id AND policy.enabled
      JOIN content_variants AS variant
        ON variant.id=automation.variant_id AND variant.tenant_id=automation.tenant_id
        AND variant.id=${variantId}::uuid AND variant.platform_code=automation.platform_code
      JOIN generation_runs AS generation
        ON generation.variant_id=variant.id AND generation.tenant_id=variant.tenant_id
        AND generation.package_id=${event.data.packageId}::uuid AND generation.status='succeeded'
      JOIN platform_accounts AS account
        ON account.id=policy.account_id AND account.tenant_id=policy.tenant_id
        AND account.status='active' AND account.publish_mode='api' AND account.deleted_at IS NULL
      WHERE automation.tenant_id=${event.tenantId}::uuid
        AND automation.publish_job_id IS NULL
        AND automation.status IN ('generation_pending','generating')
      ORDER BY generation.finished_at DESC,generation.id DESC
      LIMIT 1
      FOR UPDATE OF automation,policy
    `;
    const row = rows[0];
    if (!row) return;
    const changed = await transaction<{ id: string }[]>`
      UPDATE browser_platform_automation_runs SET
        content_version_id=${contentVersionId}::uuid,status='quality_pending',
        last_error_json=NULL,version=version+1
      WHERE id=${row.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
        AND version=${row.version}
      RETURNING id
    `;
    if (!changed[0]) throw new Error('Browser platform generation quality handoff was lost');
    await transaction`
      UPDATE browser_platform_daily_batch_items SET
        status='quality_check',content_version_id=${contentVersionId}::uuid,last_error_json=NULL
      WHERE tenant_id=${event.tenantId}::uuid
        AND automation_run_id=${row.automationRunId}::uuid
    `;
    await this.enqueueQuality(transaction, {
      actorUserId: row.actorUserId,
      contentHash: generatedHash,
      contentVersionId,
      generationRunId: row.generationRunId,
      packageId: event.data.packageId,
      projectId: event.data.projectId,
      requestId: bounded(`browser-quality-${event.eventId}`),
      tenantId: event.tenantId,
      variantId,
      workspaceId: event.data.workspaceId,
    });
  }

  public loadGatePolicy(
    client: AutomationSql,
    tenantId: string,
    variantId: string,
  ): Promise<BrowserPlatformAutomationPolicy | null> {
    return this.loadPolicy(client, tenantId, variantId);
  }

  public calculateGate(
    policy: BrowserPlatformAutomationPolicy,
    result: QualityCheckerData,
    geoScores: QualityGeoScores,
  ): BrowserPlatformQualityGate {
    const blocking = new Set(
      result.issues.filter((issue) => issue.severity === 'BLOCK').map((issue) => issue.rule_id),
    );
    const values = {
      brand_consistency: issueScore(result.issues, 'brand', 100),
      factual_accuracy: issueScore(result.issues, 'fact', geoScores.evidence),
      geo_total: geoScores.total,
      platform_fit: geoScores.platform_fit,
      question_coverage: geoScores.question,
      readability_safety: geoScores.readability_safety,
    };
    threshold(blocking, 'gate.geo_total', values.geo_total, policy.geoTotalMin);
    threshold(
      blocking,
      'gate.factual_accuracy',
      values.factual_accuracy,
      policy.factualAccuracyMin,
    );
    threshold(
      blocking,
      'gate.brand_consistency',
      values.brand_consistency,
      policy.brandConsistencyMin,
    );
    threshold(
      blocking,
      'gate.readability_safety',
      values.readability_safety,
      policy.readabilitySafetyMin,
    );
    threshold(
      blocking,
      'gate.question_coverage',
      values.question_coverage,
      policy.questionCoverageMin,
    );
    threshold(blocking, 'gate.platform_fit', values.platform_fit, policy.platformFitMin);
    if (result.decision !== 'pass') blocking.add(`quality.decision.${result.decision}`);
    return Object.freeze({
      blocking_rules: Object.freeze([...blocking].sort()),
      ...values,
      passed: blocking.size === 0,
      platform_code: policy.platformCode,
      schema_version: 'browser-platform-quality-gate@1',
    });
  }

  public async advanceAfterQuality(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    policy: BrowserPlatformAutomationPolicy,
    reportId: string,
    gate: BrowserPlatformQualityGate,
    result: QualityCheckerData,
  ): Promise<void> {
    const rows = await transaction<{ id: string; rewriteCount: number; version: number }[]>`
      SELECT id,rewrite_count AS "rewriteCount",version
      FROM browser_platform_automation_runs
      WHERE tenant_id=${event.tenantId}::uuid AND policy_id=${policy.id}::uuid
        AND variant_id=${event.data.variantId}::uuid
        AND content_version_id=${event.data.contentVersionId}::uuid AND status='quality_pending'
      FOR UPDATE
    `;
    const run = rows[0];
    if (!run) return;
    if (gate.passed) {
      await this.schedulePublication(transaction, event, policy, run, reportId);
      return;
    }
    if (event.data.validationMode === 'manual_edit') {
      const failure = errorDocument('MANUAL_EDIT_QUALITY_FAILED', {
        blocking_rules: gate.blocking_rules,
        source_publish_job_id: event.data.sourcePublishJobId,
      });
      await transaction`
        UPDATE browser_platform_automation_runs SET status='manual_required',
          last_quality_report_id=${reportId}::uuid,
          last_error_json=${JSON.stringify(failure)}::text::jsonb,
          finished_at=now(),version=version+1
        WHERE id=${run.id}::uuid AND tenant_id=${event.tenantId}::uuid
          AND version=${run.version}
      `;
      await transaction`
        UPDATE browser_platform_daily_batch_items SET status='manual_required',
          last_error_json=${JSON.stringify(failure)}::text::jsonb
        WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${run.id}::uuid
      `;
      return;
    }
    if (run.rewriteCount >= policy.maxRewrites) {
      const failure = errorDocument('QUALITY_GATE_FAILED_AFTER_MAX_REWRITES', {
        blocking_rules: gate.blocking_rules,
      });
      await transaction`
        UPDATE browser_platform_automation_runs SET status='manual_required',
          last_quality_report_id=${reportId}::uuid,last_error_json=${JSON.stringify(failure)}::text::jsonb,
          finished_at=now(),version=version+1
        WHERE id=${run.id}::uuid AND tenant_id=${event.tenantId}::uuid AND version=${run.version}
      `;
      await transaction`
        UPDATE browser_platform_daily_batch_items SET status='manual_required',
          last_error_json=${JSON.stringify(failure)}::text::jsonb
        WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${run.id}::uuid
      `;
      return;
    }
    await this.enqueueRewrite(transaction, event, policy, run, reportId, gate, result.issues);
  }

  public async failQualityExecution(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    error: unknown,
  ): Promise<void> {
    const failure = errorDocument('QUALITY_CHECK_EXECUTION_FAILED', {
      message: safeError(error),
      ...(event.data.validationMode === 'manual_edit'
        ? { source_publish_job_id: event.data.sourcePublishJobId }
        : {}),
    });
    const rows = await transaction<{ id: string }[]>`
      UPDATE browser_platform_automation_runs SET status='manual_required',
        last_error_json=${JSON.stringify(failure)}::text::jsonb,finished_at=now(),version=version+1
      WHERE tenant_id=${event.tenantId}::uuid AND variant_id=${event.data.variantId}::uuid
        AND content_version_id=${event.data.contentVersionId}::uuid AND status='quality_pending'
      RETURNING id
    `;
    if (!rows[0]) return;
    await transaction`
      UPDATE browser_platform_daily_batch_items SET status='manual_required',
        last_error_json=${JSON.stringify(failure)}::text::jsonb
      WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${rows[0].id}::uuid
    `;
  }

  public async runRewrite(raw: unknown, signal?: AbortSignal) {
    const event = validateBrowserPlatformRewriteEvent(raw);
    const claim = await this.claimRewrite(event);
    if (!claim) return { disposition: 'completed' } as const;
    try {
      const rewritten = await this.writer.rewriteBrowserPlatformVariant({
        context: claim.context,
        currentContent: claim.content,
        issues: claim.issues,
        platformCode: event.data.platformCode,
        requestId: event.data.requestId,
        ...(signal ? { signal } : {}),
        writerInput: claim.writerInput,
      });
      await this.saveRewrite(event, claim, rewritten);
      return { disposition: 'processed' } as const;
    } catch (error) {
      await this.failRewrite(event, claim, error);
      throw error;
    }
  }

  private claimRewrite(event: ReturnType<typeof validateBrowserPlatformRewriteEvent>) {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<
        {
          actorUserId: string;
          automationVersion: number;
          content: unknown;
          context: ContentWriterRunContext;
          lastError: unknown;
          runVersion: number;
          variantVersion: number;
        }[]
      >`
        SELECT policy.created_by AS "actorUserId",automation.version AS "automationVersion",
          version.content_json AS content,automation.last_error_json AS "lastError",
          generation.version AS "runVersion",variant.version AS "variantVersion",
          jsonb_build_object(
            'batchKey',generation.id::text,'inputHash',generation.input_hash,
            'modelKey',generation.model_key,'modelPolicy','quality',
            'packageId',generation.package_id::text,'projectId',generation.project_id::text,
            'promptVersionId',generation.prompt_version_id::text,'runId',generation.id::text,
            'skillVersion',generation.skill_version,'skillName','content-writer',
            'tenantId',generation.tenant_id::text,'variantId',generation.variant_id::text,
            'workspaceId',generation.workspace_id::text
          ) AS context
        FROM browser_platform_automation_runs AS automation
        JOIN browser_platform_automation_policies AS policy
          ON policy.id=automation.policy_id AND policy.tenant_id=automation.tenant_id AND policy.enabled
        JOIN content_variants AS variant
          ON variant.id=automation.variant_id AND variant.tenant_id=automation.tenant_id
          AND variant.platform_code=automation.platform_code
        JOIN content_versions AS version
          ON version.id=automation.content_version_id AND version.tenant_id=automation.tenant_id
        JOIN generation_runs AS generation
          ON generation.id=${event.data.generationRunId}::uuid
          AND generation.tenant_id=automation.tenant_id AND generation.variant_id=variant.id
        WHERE automation.id=${event.data.automationRunId}::uuid
          AND automation.tenant_id=${event.tenantId}::uuid
          AND automation.platform_code=${event.data.platformCode}
          AND automation.content_version_id=${event.data.contentVersionId}::uuid
          AND automation.rewrite_count=${event.data.rewriteAttempt}
          AND automation.status='rewrite_pending' AND variant.status='quality_failed'
          AND generation.status='queued'
        FOR UPDATE OF automation,variant,generation
      `;
      const row = rows[0];
      if (!row) return null;
      const content = validateGeneratedContent(row.content, event.data.platformCode);
      const writerInput = await loadWriterInput(
        transaction,
        event.tenantId,
        event.data.packageId,
        event.data.variantId,
        event.data.platformCode,
      );
      const runs = await transaction<{ id: string }[]>`
        UPDATE generation_runs SET status='running',started_at=now(),version=version+1
        WHERE id=${event.data.generationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='queued' AND version=${row.runVersion}
        RETURNING id
      `;
      const variants = await transaction<{ id: string }[]>`
        UPDATE content_variants SET status='generating',version=version+1
        WHERE id=${event.data.variantId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='quality_failed' AND version=${row.variantVersion}
        RETURNING id
      `;
      const automations = await transaction<{ id: string }[]>`
        UPDATE browser_platform_automation_runs SET status='rewriting',version=version+1
        WHERE id=${event.data.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='rewrite_pending' AND version=${row.automationVersion}
        RETURNING id
      `;
      if (!runs[0] || !variants[0] || !automations[0]) throw new Error('Rewrite lease was lost');
      return Object.freeze({
        actorUserId: row.actorUserId,
        automationVersion: row.automationVersion + 1,
        content,
        context: row.context,
        issues: promptIssues(row.lastError),
        runVersion: row.runVersion + 1,
        variantVersion: row.variantVersion + 1,
        writerInput,
      });
    });
  }

  private saveRewrite(
    event: ReturnType<typeof validateBrowserPlatformRewriteEvent>,
    claim: NonNullable<Awaited<ReturnType<BrowserPlatformAutomation['claimRewrite']>>>,
    rewritten: GeneratedContent,
  ) {
    return this.client.begin(async (transaction) => {
      const content = validateGeneratedContent(rewritten, event.data.platformCode);
      const synthetic = generationEvent(event, claim.writerInput);
      const versionId = await insertGeneratedVersion(
        transaction,
        synthetic,
        event.data.variantId,
        event.data.generationRunId,
        content,
      );
      const variants = await transaction<{ id: string }[]>`
        UPDATE content_variants SET current_content_version_id=${versionId}::uuid,
          status='generated',quality_score=NULL,version=version+1
        WHERE id=${event.data.variantId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='generating' AND version=${claim.variantVersion}
        RETURNING id
      `;
      const runs = await transaction<{ id: string }[]>`
        UPDATE generation_runs SET status='succeeded',finished_at=now(),error_json=NULL,version=version+1
        WHERE id=${event.data.generationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='running' AND version=${claim.runVersion}
        RETURNING id
      `;
      const automations = await transaction<{ id: string }[]>`
        UPDATE browser_platform_automation_runs SET content_version_id=${versionId}::uuid,
          status='quality_pending',last_error_json=NULL,version=version+1
        WHERE id=${event.data.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='rewriting' AND version=${claim.automationVersion}
        RETURNING id
      `;
      if (!variants[0] || !runs[0] || !automations[0]) throw new Error('Rewrite result is stale');
      await transaction`
        UPDATE browser_platform_daily_batch_items SET status='quality_check',
          content_version_id=${versionId}::uuid,last_error_json=NULL
        WHERE tenant_id=${event.tenantId}::uuid
          AND automation_run_id=${event.data.automationRunId}::uuid
      `;
      await this.enqueueQuality(transaction, {
        actorUserId: claim.actorUserId,
        contentHash: contentHash(content),
        contentVersionId: versionId,
        generationRunId: event.data.generationRunId,
        packageId: event.data.packageId,
        projectId: event.data.projectId,
        requestId: bounded(`browser-quality-${event.eventId}`),
        tenantId: event.tenantId,
        variantId: event.data.variantId,
        workspaceId: event.data.workspaceId,
      });
    });
  }

  private failRewrite(
    event: ReturnType<typeof validateBrowserPlatformRewriteEvent>,
    claim: NonNullable<Awaited<ReturnType<BrowserPlatformAutomation['claimRewrite']>>>,
    error: unknown,
  ) {
    return this.client.begin(async (transaction) => {
      const failure = errorDocument('BROWSER_PLATFORM_REWRITE_FAILED', {
        message: safeError(error),
        prompt_issues: claim.issues,
      });
      await transaction`
        UPDATE generation_runs SET status='failed',finished_at=now(),
          error_json=${JSON.stringify(failure)}::text::jsonb,version=version+1
        WHERE id=${event.data.generationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='running' AND version=${claim.runVersion}
      `;
      await transaction`
        UPDATE content_variants SET status='quality_failed',version=version+1
        WHERE id=${event.data.variantId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='generating' AND version=${claim.variantVersion}
      `;
      await transaction`
        UPDATE browser_platform_automation_runs SET status='manual_required',
          last_error_json=${JSON.stringify(failure)}::text::jsonb,finished_at=now(),version=version+1
        WHERE id=${event.data.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='rewriting' AND version=${claim.automationVersion}
      `;
      await transaction`
        UPDATE browser_platform_daily_batch_items SET status='manual_required',
          last_error_json=${JSON.stringify(failure)}::text::jsonb
        WHERE tenant_id=${event.tenantId}::uuid
          AND automation_run_id=${event.data.automationRunId}::uuid
      `;
    });
  }

  private loadPolicy(client: AutomationSql, tenantId: string, variantId: string) {
    return client<BrowserPlatformAutomationPolicy[]>`
      SELECT policy.id,policy.account_id AS "accountId",policy.created_by AS "createdBy",
        policy.platform_code AS "platformCode",policy.geo_total_min AS "geoTotalMin",
        policy.factual_accuracy_min AS "factualAccuracyMin",
        policy.brand_consistency_min AS "brandConsistencyMin",
        policy.readability_safety_min AS "readabilitySafetyMin",
        policy.question_coverage_min AS "questionCoverageMin",
        policy.platform_fit_min AS "platformFitMin",policy.max_rewrites AS "maxRewrites",
        policy.publish_attempt_limit AS "publishAttemptLimit",
        policy.daily_schedule_times::text[] AS "scheduleTimes"
      FROM browser_platform_automation_policies AS policy
      JOIN browser_platform_automation_runs AS automation
        ON automation.policy_id=policy.id AND automation.tenant_id=policy.tenant_id
      JOIN platform_accounts AS account
        ON account.id=policy.account_id AND account.tenant_id=policy.tenant_id
        AND account.status='active' AND account.publish_mode='api' AND account.deleted_at IS NULL
      WHERE policy.tenant_id=${tenantId}::uuid AND automation.variant_id=${variantId}::uuid
        AND policy.enabled AND automation.status IN ('quality_pending','media_pending')
      LIMIT 1
    `.then((rows) => rows[0] ?? null);
  }

  private async enqueueQuality(transaction: postgres.TransactionSql, input: QualityQueueInput) {
    const inputHash = sha256(
      qualityEvaluationFingerprintSource({
        contentHash: input.contentHash,
        modelKey: this.config.qualityModelKey,
        promptVersionId: this.config.qualityPromptVersionId,
        skillVersion: this.config.qualitySkillVersion,
      }),
    );
    const rows = await transaction<{ id: string }[]>`
      INSERT INTO generation_runs (
        tenant_id,workspace_id,project_id,package_id,variant_id,skill_name,skill_version,
        prompt_version_id,model_key,input_hash,request_id
      ) VALUES (
        ${input.tenantId}::uuid,${input.workspaceId}::uuid,${input.projectId}::uuid,
        ${input.packageId}::uuid,${input.variantId}::uuid,'quality-checker',
        ${this.config.qualitySkillVersion},${this.config.qualityPromptVersionId}::uuid,
        ${this.config.qualityModelKey},${inputHash},${input.requestId}
      ) RETURNING id
    `;
    const qualityRunId = required(rows[0]?.id, 'Quality run insert failed');
    const queued = createEvent(
      input.tenantId,
      'content.variant.quality_check_requested.v1',
      'content_variant',
      input.variantId,
      {
        actor_user_id: input.actorUserId,
        content_hash: input.contentHash,
        content_version_id: input.contentVersionId,
        generation_run_id: qualityRunId,
        package_id: input.packageId,
        project_id: input.projectId,
        request_id: input.requestId,
        variant_id: input.variantId,
        workspace_id: input.workspaceId,
      },
    );
    await insertOutbox(transaction, queued);
  }

  private async enqueueRewrite(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    policy: BrowserPlatformAutomationPolicy,
    run: { readonly id: string; readonly rewriteCount: number; readonly version: number },
    reportId: string,
    gate: BrowserPlatformQualityGate,
    issues: readonly QualityIssue[],
  ) {
    const attempt = run.rewriteCount + 1;
    const diagnostics = rewriteDiagnostics(policy, gate, issues);
    const requestId = bounded(`${policy.platformCode}-rewrite-${run.id}-${attempt}`);
    const rows = await transaction<{ id: string }[]>`
      INSERT INTO generation_runs (
        tenant_id,workspace_id,project_id,package_id,variant_id,skill_name,skill_version,
        prompt_version_id,model_key,input_hash,request_id
      ) VALUES (
        ${event.tenantId}::uuid,${event.data.workspaceId}::uuid,${event.data.projectId}::uuid,
        ${event.data.packageId}::uuid,${event.data.variantId}::uuid,'content-writer',
        ${this.config.writerSkillVersion},${this.config.writerPromptVersionId}::uuid,
        ${this.config.rewriteModelKey},
        ${sha256(JSON.stringify({ attempt, content_version_id: event.data.contentVersionId, diagnostics }))},
        ${requestId}
      ) RETURNING id
    `;
    const generationRunId = required(rows[0]?.id, 'Rewrite run insert failed');
    const changed = await transaction<{ id: string }[]>`
      UPDATE browser_platform_automation_runs SET status='rewrite_pending',rewrite_count=${attempt},
        last_quality_report_id=${reportId}::uuid,
        last_error_json=${JSON.stringify(
          errorDocument('QUALITY_GATE_REWRITE_REQUIRED', {
            blocking_rules: gate.blocking_rules,
            prompt_issues: diagnostics,
          }),
        )}::text::jsonb,version=version+1
      WHERE id=${run.id}::uuid AND tenant_id=${event.tenantId}::uuid AND version=${run.version}
      RETURNING id
    `;
    if (!changed[0]) throw new Error('Automation run lease was lost');
    await transaction`
      UPDATE browser_platform_daily_batch_items SET status='rewriting'
      WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${run.id}::uuid
    `;
    const queued = createEvent(
      event.tenantId,
      'content.variant.browser_platform_rewrite_requested.v1',
      'content_variant',
      event.data.variantId,
      {
        actor_user_id: event.data.actorUserId,
        automation_run_id: run.id,
        content_version_id: event.data.contentVersionId,
        generation_run_id: generationRunId,
        package_id: event.data.packageId,
        platform_code: policy.platformCode,
        project_id: event.data.projectId,
        request_id: requestId,
        rewrite_attempt: attempt,
        variant_id: event.data.variantId,
        workspace_id: event.data.workspaceId,
      },
    );
    await insertOutbox(transaction, queued);
  }

  private async schedulePublication(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    policy: BrowserPlatformAutomationPolicy,
    run: { readonly id: string; readonly version: number },
    reportId: string,
  ) {
    await transaction`
      SELECT id FROM browser_platform_automation_policies
      WHERE id=${policy.id}::uuid AND tenant_id=${event.tenantId}::uuid FOR UPDATE
    `;
    const occupied = await transaction<{ scheduledAt: Date }[]>`
      SELECT job.scheduled_at AS "scheduledAt"
      FROM browser_platform_automation_runs AS automation
      JOIN publish_jobs AS job ON job.id=automation.publish_job_id AND job.tenant_id=automation.tenant_id
        AND job.status IN ('scheduled','publishing','published')
      WHERE automation.tenant_id=${event.tenantId}::uuid AND automation.policy_id=${policy.id}::uuid
        AND job.scheduled_at >= date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai')
          AT TIME ZONE 'Asia/Shanghai'
    `;
    const scheduledAt = nextSchedule(
      new Date(),
      policy.scheduleTimes,
      occupied.map((row) => row.scheduledAt),
    );
    const origin = `${policy.platformCode}_automation` as const;
    const jobs = await transaction<{ id: string; version: number }[]>`
      INSERT INTO publish_jobs (
        tenant_id,variant_id,content_version_id,account_id,scheduled_at,idempotency_key,
        payload_hash,status,created_by,origin
      ) VALUES (
        ${event.tenantId}::uuid,${event.data.variantId}::uuid,${event.data.contentVersionId}::uuid,
        ${policy.accountId}::uuid,${scheduledAt},
        ${`${policy.platformCode}:${event.data.variantId}:${event.data.contentVersionId}`},
        ${event.data.contentHash},'scheduled',${policy.createdBy}::uuid,${origin}
      ) ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
      RETURNING id,version
    `;
    const job = jobs[0];
    if (!job) throw new Error('Publish job insert failed');
    const variants = await transaction<{ id: string }[]>`
      UPDATE content_variants SET status='scheduled',version=version+1
      WHERE id=${event.data.variantId}::uuid AND tenant_id=${event.tenantId}::uuid
        AND current_content_version_id=${event.data.contentVersionId}::uuid AND status='quality_passed'
      RETURNING id
    `;
    const changed = await transaction<{ id: string }[]>`
      UPDATE browser_platform_automation_runs SET status='scheduled',
        last_quality_report_id=${reportId}::uuid,publish_job_id=${job.id}::uuid,
        last_error_json=NULL,version=version+1
      WHERE id=${run.id}::uuid AND tenant_id=${event.tenantId}::uuid AND version=${run.version}
      RETURNING id
    `;
    if (!variants[0] || !changed[0]) throw new Error('Automation publish handoff was lost');
    await transaction`
      UPDATE browser_platform_daily_batch_items SET status='scheduled',
        content_version_id=${event.data.contentVersionId}::uuid,publish_job_id=${job.id}::uuid,
        scheduled_at=${scheduledAt},qualified_at=now(),last_error_json=NULL
      WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${run.id}::uuid
    `;
    await transaction`
      UPDATE browser_platform_daily_batches AS batch SET
        status=CASE WHEN (
          SELECT count(*) FROM browser_platform_daily_batches AS day_batch
          JOIN browser_platform_daily_batch_items AS item
            ON item.batch_id=day_batch.id AND item.tenant_id=day_batch.tenant_id
          WHERE day_batch.tenant_id=batch.tenant_id AND day_batch.policy_id=batch.policy_id
            AND day_batch.business_date=batch.business_date
            AND item.status IN ('scheduled','processing','published','publish_failed')
        ) >= policy.daily_target_count THEN 'scheduled' ELSE 'running' END,
        scheduled_at=CASE WHEN (
          SELECT count(*) FROM browser_platform_daily_batches AS day_batch
          JOIN browser_platform_daily_batch_items AS item
            ON item.batch_id=day_batch.id AND item.tenant_id=day_batch.tenant_id
          WHERE day_batch.tenant_id=batch.tenant_id AND day_batch.policy_id=batch.policy_id
            AND day_batch.business_date=batch.business_date
            AND item.status IN ('scheduled','processing','published','publish_failed')
        ) >= policy.daily_target_count THEN COALESCE(batch.scheduled_at,now()) ELSE batch.scheduled_at END,
        version=batch.version+1
      FROM browser_platform_automation_policies AS policy
      WHERE policy.id=batch.policy_id AND policy.tenant_id=batch.tenant_id
        AND batch.tenant_id=${event.tenantId}::uuid AND batch.status='running'
        AND EXISTS (
          SELECT 1 FROM browser_platform_daily_batch_items AS item
          WHERE item.tenant_id=batch.tenant_id AND item.batch_id=batch.id
            AND item.automation_run_id=${run.id}::uuid
        )
    `;
    const queued = createEvent(
      event.tenantId,
      'publishing.job.execution_requested.v1',
      'publish_job',
      job.id,
      {
        job_id: job.id,
        job_version: job.version,
        request_id: bounded(`${policy.platformCode}-publish-${run.id}`),
        scheduled_at: scheduledAt.toISOString(),
      },
    );
    await insertOutbox(transaction, queued, scheduledAt);
  }
}

async function loadWriterInput(
  transaction: postgres.TransactionSql,
  tenantId: string,
  packageId: string,
  variantId: string,
  platformCode: Platform,
): Promise<JsonObject> {
  const rows = await transaction<{ writerInput: unknown }[]>`
    SELECT payload_json->'data'->'writer_input' AS "writerInput"
    FROM outbox_events
    WHERE tenant_id=${tenantId}::uuid AND aggregate_id=${packageId}::uuid
      AND event_type='content.package.generation_requested.v1'
      AND payload_json->'data'->'variant_runs' @>
        ${JSON.stringify([{ variant_id: variantId }])}::text::jsonb
    ORDER BY created_at DESC,id DESC
    LIMIT 1
  `;
  return buildBrowserPlatformRewriteInput(rows[0]?.writerInput, platformCode);
}

export function buildBrowserPlatformRewriteInput(
  value: unknown,
  platformCode: Platform,
): JsonObject {
  if (!record(value)) throw new Error('Original Content Writer input is missing');
  const brief = record(value['brief']) ? value['brief'] : {};
  const constraints = record(brief['constraints']) ? brief['constraints'] : {};
  const rulesByCode = record(value['platform_rules_by_code'])
    ? value['platform_rules_by_code']
    : {};
  const platformRules = rulesByCode[platformCode];
  if (!record(platformRules)) throw new Error(`${platformCode} platform rules are missing`);
  const strategy = record(value['strategy']) ? value['strategy'] : {};
  const citations = Array.isArray(value['citations']) ? value['citations'] : [];
  const locked = Array.isArray(value['locked_blocks'])
    ? value['locked_blocks'].filter(
        (item) =>
          record(item) &&
          (item['platform_code'] === 'master' || item['platform_code'] === platformCode),
      )
    : [];
  const additional =
    platformCode === 'lieju'
      ? '这是列举网自动化分类信息。标题保持5-30字并以用户问题或解决方法为中心，自然使用“如何、怎么、指南、方法、哪些”等问法之一。允许明确介绍本企业服务并自然提示通过页面联系方式咨询；不得在正文写具体电话或手机号、微信/QQ账号或网址，不得使用极限词、排名、竞品贬损、虚假价格、虚假资质、虚构案例、客户评价或结果保证。'
      : '这是搜狐号自动化图文。不得声明原创，不得伪造热点、排行、亲历或用户评价。';
  const originalAdditional =
    typeof constraints['additional_instructions'] === 'string'
      ? constraints['additional_instructions'].trim()
      : '';
  return {
    brief: {
      ...(brief as JsonObject),
      constraints: {
        ...(constraints as JsonObject),
        additional_instructions: [originalAdditional, additional].filter(Boolean).join('\n'),
      },
      platform_codes: [platformCode],
    },
    citations: citations as JsonObject[],
    generation_mode: 'rewrite',
    locked_blocks: locked as JsonObject[],
    platform_rules_by_code: { [platformCode]: platformRules as JsonObject },
    strategy: strategy as JsonObject,
  };
}

function generationEvent(
  event: ReturnType<typeof validateBrowserPlatformRewriteEvent>,
  writerInput: JsonObject,
): ValidatedGenerationEvent {
  return Object.freeze({
    data: Object.freeze({
      actorUserId: event.data.actorUserId,
      inputHash: sha256(JSON.stringify(writerInput)),
      masterRunId: event.data.generationRunId,
      modelKey: '',
      modelPolicy: 'quality' as const,
      packageId: event.data.packageId,
      projectId: event.data.projectId,
      promptVersionId: '',
      requestId: event.data.requestId,
      skillVersion: '',
      variantRuns: Object.freeze([
        {
          platformCode: event.data.platformCode,
          runId: event.data.generationRunId,
          variantId: event.data.variantId,
        },
      ]),
      workspaceId: event.data.workspaceId,
      writerInput,
    }),
    eventId: event.eventId,
    occurredAt: new Date().toISOString(),
    tenantId: event.tenantId,
  });
}

function rewriteDiagnostics(
  policy: BrowserPlatformAutomationPolicy,
  gate: BrowserPlatformQualityGate,
  issues: readonly QualityIssue[],
) {
  const details = issues.map((issue) =>
    [issue.rule_id, issue.location, issue.message, issue.suggestion].filter(Boolean).join(' | '),
  );
  const thresholds = gate.blocking_rules
    .filter((rule) => rule.startsWith('gate.'))
    .map((rule) => `${rule} 未达到冻结门槛`);
  return Object.freeze([
    `平台：${policy.platformCode}。必须逐项修复当前报告，不得沿用旧报告或忽略问题。`,
    ...details,
    ...thresholds,
  ]);
}

function promptIssues(value: unknown): readonly string[] {
  if (!record(value) || !Array.isArray(value['prompt_issues'])) return Object.freeze([]);
  return Object.freeze(
    value['prompt_issues'].filter((item): item is string => typeof item === 'string'),
  );
}

function issueScore(issues: readonly QualityIssue[], category: string, fallback: number) {
  const scores = issues
    .filter((issue) => issue.rule_id.toLowerCase().includes(category))
    .map((issue) => (issue.severity === 'BLOCK' ? 0 : issue.severity === 'WARN' ? 80 : 100));
  return scores.length ? Math.min(...scores) : fallback;
}

function threshold(blocking: Set<string>, code: string, value: number, minimum: number) {
  if (value < minimum) blocking.add(code);
}

export function nextSchedule(now: Date, slots: readonly string[], occupied: readonly Date[]) {
  const used = new Set(occupied.map((date) => date.toISOString()));
  const formatter = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const date = `${parts['year']}-${parts['month']}-${parts['day']}`;
  for (const slot of slots) {
    const candidate = new Date(`${date}T${slot}+08:00`);
    if (candidate > now && !used.has(candidate.toISOString())) return candidate;
  }
  const fallback = new Date(now.getTime() + 5 * 60_000);
  while (used.has(fallback.toISOString())) fallback.setMinutes(fallback.getMinutes() + 5);
  return fallback;
}

function createEvent(
  tenantId: string,
  eventType: EventType,
  aggregateType: AggregateType,
  aggregateId: string,
  data: JsonObject,
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
  nextAttemptAt?: Date,
) {
  await transaction`
    INSERT INTO outbox_events (
      id,tenant_id,event_type,aggregate_type,aggregate_id,payload_json,next_attempt_at
    ) VALUES (
      ${event.event_id}::uuid,${event.tenant.id}::uuid,${event.event_type},
      ${event.aggregate.type},${event.aggregate.id}::uuid,${JSON.stringify(event)}::text::jsonb,
      ${nextAttemptAt ?? new Date()}
    )
  `;
}

function errorDocument(code: string, values: Readonly<Record<string, unknown>>) {
  return { code, ...values, schema_version: 'browser-platform-automation-error@1' };
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function bounded(value: string) {
  return value.slice(0, 80);
}

function required(value: string | undefined, message: string) {
  if (!value) throw new Error(message);
  return value;
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 1000) : 'Unknown error';
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
