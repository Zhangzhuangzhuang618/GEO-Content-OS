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

import {
  validateBaijiahaoAdaptationEvent,
  type ValidatedBaijiahaoAdaptationEvent,
} from './baijiahao-adaptation.event.js';
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
import {
  validatePublishingPublishedEvent,
  type ValidatedPublishingPublishedEvent,
} from './publishing-published.event.js';
import type { RuntimeContentWriter } from './runtime-content-writer.js';

type AutomationSql = postgres.Sql | postgres.TransactionSql;

export interface BaijiahaoQualityGate {
  readonly blocking_rules: readonly string[];
  readonly brand_consistency: number;
  readonly factual_accuracy: number;
  readonly geo_total: number;
  readonly passed: boolean;
  readonly platform_fit: number;
  readonly question_coverage: number;
  readonly readability_safety: number;
  readonly schema_version: 'baijiahao-quality-gate@1';
  readonly source_similarity: number | null;
}

export interface BaijiahaoAutomationPolicy {
  readonly accountId: string;
  readonly brandConsistencyMin: number;
  readonly createdBy: string;
  readonly factualAccuracyMin: number;
  readonly geoTotalMin: number;
  readonly id: string;
  readonly maxRewrites: number;
  readonly maxSourceSimilarity: number;
  readonly platformFitMin: number;
  readonly publishAttemptLimit: number;
  readonly questionCoverageMin: number;
  readonly readabilitySafetyMin: number;
  readonly scheduleTimes: readonly string[];
  readonly sourceSimilarity: number | null;
}

interface SourcePolicyRow {
  readonly accountId: string;
  readonly candidateCount: number;
  readonly createdBy: string;
  readonly dailyCandidateLimit: number;
  readonly dailyTargetCount: number;
  readonly id: string;
  readonly scheduleTimes: readonly string[];
}

interface SourceRow {
  readonly audience: string;
  readonly briefId: string;
  readonly constraints: JsonObject;
  readonly content: unknown;
  readonly contentHash: string;
  readonly objective: string;
  readonly packageId: string;
  readonly title: string;
}

interface WriterCitation {
  readonly chunkId: string;
  readonly citationId: string;
  readonly quoteText: string;
  readonly sourceId: string;
}

interface WriterInputScope {
  readonly tenantId: string;
  readonly workspaceId: string;
}

interface AdaptationClaim {
  readonly actorUserId: string;
  readonly automationVersion: number;
  readonly currentContent?: GeneratedContent;
  readonly currentContentHash: string;
  readonly issues: readonly string[];
  readonly modelKey: string;
  readonly packageId: string;
  readonly projectId: string;
  readonly promptVersionId: string;
  readonly runVersion: number;
  readonly skillVersion: string;
  readonly sourceContent: GeneratedContent;
  readonly sourceMode: 'independent' | 'official_site_derived';
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

interface GenerationQualityHandoff extends QualityQueueInput {
  readonly automationRunId: string;
  readonly automationVersion: number;
  readonly sourceSimilarity: number | null;
}

const REGENERATED_CONTENT_RECOVERY_CODES = Object.freeze([
  'ADAPTATION_EXECUTION_FAILED',
  'CONTENT_GENERATION_FAILED_RETIRED',
  'QUALITY_CHECK_EXECUTION_FAILED',
  'QUALITY_GATE_FAILED_AFTER_MAX_REWRITES',
]);

export class BaijiahaoAutomation {
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
    content: GeneratedContent,
  ): Promise<void> {
    const rows = await transaction<
      {
        actorUserId: string;
        automationRunId: string;
        sourceContent: unknown | null;
        sourceMode: 'independent' | 'official_site_derived';
        version: number;
      }[]
    >`
      SELECT
        policy.created_by AS "actorUserId",automation.id AS "automationRunId",
        automation.source_mode AS "sourceMode",source.content_json AS "sourceContent",
        automation.version
      FROM baijiahao_automation_runs AS automation
      JOIN baijiahao_automation_policies AS policy
        ON policy.id=automation.policy_id AND policy.tenant_id=automation.tenant_id
        AND policy.enabled
      JOIN content_variants AS variant
        ON variant.id=automation.variant_id AND variant.tenant_id=automation.tenant_id
        AND variant.id=${variantId}::uuid AND variant.platform_code='baijiahao'
      JOIN platform_accounts AS account
        ON account.id=policy.account_id AND account.tenant_id=policy.tenant_id
        AND account.status='active' AND account.publish_mode='api' AND account.deleted_at IS NULL
      LEFT JOIN content_versions AS source
        ON source.id=automation.source_content_version_id
        AND source.tenant_id=automation.tenant_id
      WHERE automation.tenant_id=${event.tenantId}::uuid
        AND automation.publish_job_id IS NULL
        AND (
          automation.status IN (
            'generation_pending','generating','adaptation_pending','adapting',
            'quality_pending','rewrite_pending','rewriting'
          )
          OR (
            automation.status IN ('manual_required','disabled')
            AND COALESCE(automation.last_error_json->>'code','') = ANY(
              ${transaction.array([...REGENERATED_CONTENT_RECOVERY_CODES], 25)}::text[]
            )
          )
        )
      FOR UPDATE OF automation,policy
    `;
    const row = rows[0];
    if (!row) return;
    const similarity =
      row.sourceMode === 'official_site_derived'
        ? sourceSimilarity(validateGeneratedContent(row.sourceContent, 'official_site'), content)
        : null;
    await this.handoffGeneratedQuality(transaction, {
      actorUserId: row.actorUserId,
      automationRunId: row.automationRunId,
      automationVersion: row.version,
      contentHash: generatedHash,
      contentVersionId,
      packageId: event.data.packageId,
      projectId: event.data.projectId,
      requestId: boundedRequestId(`baijiahao-quality-${event.eventId}`),
      sourceSimilarity: similarity,
      tenantId: event.tenantId,
      variantId,
      workspaceId: event.data.workspaceId,
    });
  }

  public async recoverGeneratedIndependentCandidates(): Promise<number> {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<
        {
          actorUserId: string;
          automationRunId: string;
          automationVersion: number;
          contentHash: string;
          contentVersionId: string;
          packageId: string;
          projectId: string;
          tenantId: string;
          variantId: string;
          workspaceId: string;
        }[]
      >`
        SELECT
          policy.created_by AS "actorUserId",automation.id AS "automationRunId",
          automation.version AS "automationVersion",version.content_hash AS "contentHash",
          version.id AS "contentVersionId",package.id AS "packageId",
          package.project_id AS "projectId",automation.tenant_id AS "tenantId",
          variant.id AS "variantId",package.workspace_id AS "workspaceId"
        FROM baijiahao_automation_runs AS automation
        JOIN baijiahao_automation_policies AS policy
          ON policy.id=automation.policy_id AND policy.tenant_id=automation.tenant_id
          AND policy.enabled
        JOIN platform_accounts AS account
          ON account.id=policy.account_id AND account.tenant_id=policy.tenant_id
          AND account.status='active' AND account.publish_mode='api'
          AND account.deleted_at IS NULL
        JOIN content_variants AS variant
          ON variant.id=automation.variant_id AND variant.tenant_id=automation.tenant_id
          AND variant.platform_code='baijiahao' AND variant.status='generated'
          AND variant.current_content_version_id IS NOT NULL
        JOIN content_packages AS package
          ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
          AND package.deleted_at IS NULL
        JOIN content_versions AS version
          ON version.id=variant.current_content_version_id
          AND version.tenant_id=variant.tenant_id AND version.package_id=package.id
          AND version.variant_id=variant.id
        JOIN baijiahao_daily_batch_items AS item
          ON item.automation_run_id=automation.id AND item.tenant_id=automation.tenant_id
          AND item.variant_id=variant.id AND item.status='generating'
        WHERE automation.source_mode='independent'
          AND automation.status IN ('generation_pending','generating')
          AND automation.content_version_id IS NULL
        ORDER BY automation.created_at,automation.id
        FOR UPDATE OF automation SKIP LOCKED
      `;
      for (const row of rows) {
        await this.handoffGeneratedQuality(transaction, {
          ...row,
          requestId: boundedRequestId(`baijiahao-quality-recovery-${row.automationRunId}`),
          sourceSimilarity: null,
        });
      }
      return rows.length;
    });
  }

  public async handlePublishedSource(
    raw: unknown,
  ): Promise<{ readonly disposition: 'completed' | 'processed' }> {
    const event = validatePublishingPublishedEvent(raw);
    if (
      event.data.platformCode !== 'official_site' ||
      event.data.origin !== 'official_site_automation' ||
      event.data.externalUrl === null
    ) {
      return { disposition: 'completed' };
    }
    return this.client.begin(async (transaction) => {
      const sourceRows = await transaction<SourceRow[]>`
        SELECT
          brief.id AS "briefId", brief.title, brief.objective, brief.audience,
          brief.constraints_json AS constraints, package.id AS "packageId",
          version.content_json AS content, version.content_hash AS "contentHash"
        FROM publish_jobs AS job
        JOIN content_versions AS version
          ON version.id=job.content_version_id AND version.tenant_id=job.tenant_id
        JOIN content_variants AS variant
          ON variant.id=job.variant_id AND variant.tenant_id=job.tenant_id
          AND variant.current_content_version_id=version.id
          AND variant.platform_code='official_site'
        JOIN content_packages AS package
          ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
          AND package.project_id=${event.data.projectId}::uuid
          AND package.workspace_id=${event.data.workspaceId}::uuid
          AND package.deleted_at IS NULL
        JOIN briefs AS brief
          ON brief.id=package.brief_id AND brief.tenant_id=package.tenant_id
        WHERE job.id=${event.data.jobId}::uuid AND job.tenant_id=${event.tenantId}::uuid
          AND job.status='published' AND job.published_at IS NOT NULL
          AND job.origin='official_site_automation'
          AND job.content_version_id=${event.data.contentVersionId}::uuid
          AND job.external_url=${event.data.externalUrl}
        FOR UPDATE OF job
      `;
      const source = sourceRows[0];
      if (!source) return { disposition: 'completed' } as const;
      const policies = await transaction<SourcePolicyRow[]>`
        SELECT
          policy.id, policy.account_id AS "accountId", policy.created_by AS "createdBy",
          policy.daily_target_count AS "dailyTargetCount",
          policy.daily_candidate_limit AS "dailyCandidateLimit",
          policy.daily_schedule_times::text[] AS "scheduleTimes",
          (
            SELECT count(*)::integer
            FROM baijiahao_automation_runs AS run
            WHERE run.tenant_id=policy.tenant_id AND run.policy_id=policy.id
              AND (run.created_at AT TIME ZONE policy.daily_timezone)::date =
                (now() AT TIME ZONE policy.daily_timezone)::date
              AND run.status <> 'skipped'
          ) AS "candidateCount"
        FROM baijiahao_automation_policies AS policy
        JOIN platform_accounts AS account
          ON account.id=policy.account_id AND account.tenant_id=policy.tenant_id
          AND account.workspace_id=policy.workspace_id AND account.platform_code='baijiahao'
          AND account.status='active' AND account.publish_mode='api'
          AND account.deleted_at IS NULL
        WHERE policy.tenant_id=${event.tenantId}::uuid
          AND policy.workspace_id=${event.data.workspaceId}::uuid
          AND policy.project_id=${event.data.projectId}::uuid
          AND policy.enabled AND policy.source_mode='official_site_derived'
        LIMIT 1
        FOR UPDATE OF policy
      `;
      const policy = policies[0];
      if (!policy) return { disposition: 'completed' } as const;
      const existing = await transaction<{ id: string }[]>`
        SELECT id FROM baijiahao_automation_runs
        WHERE tenant_id=${event.tenantId}::uuid AND policy_id=${policy.id}::uuid
          AND source_content_version_id=${event.data.contentVersionId}::uuid
        LIMIT 1
      `;
      if (existing.length > 0) return { disposition: 'completed' } as const;

      const sourceContent = validateGeneratedContent(source.content, 'official_site');
      const reason = assessBaijiahaoSourceSuitability(sourceContent, source.objective);
      const targetSatisfiedToday = await transaction<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM baijiahao_automation_runs
        WHERE tenant_id=${event.tenantId}::uuid AND policy_id=${policy.id}::uuid
          AND (created_at AT TIME ZONE 'Asia/Shanghai')::date=
            (now() AT TIME ZONE 'Asia/Shanghai')::date
          AND status IN (
            'media_pending','publish_pending','scheduled','publishing','processing','published'
          )
      `;
      const limitReason =
        Number(targetSatisfiedToday[0]?.count ?? 0) >= policy.dailyTargetCount
          ? 'daily_target_reached'
          : policy.candidateCount >= policy.dailyCandidateLimit
            ? 'daily_candidate_limit_reached'
            : null;
      const existingVariant = await transaction<{ id: string }[]>`
        SELECT id FROM content_variants
        WHERE tenant_id=${event.tenantId}::uuid AND package_id=${source.packageId}::uuid
          AND platform_code='baijiahao'
        LIMIT 1
      `;
      const skipReason =
        reason ?? limitReason ?? (existingVariant.length > 0 ? 'variant_exists' : null);
      if (skipReason) {
        await this.recordSkippedSource(transaction, event, policy.id, skipReason, sourceContent);
        return { disposition: 'processed' } as const;
      }

      const variants = await transaction<{ id: string; version: number }[]>`
        INSERT INTO content_variants (
          tenant_id,package_id,platform_code,platform_account_id,status,is_required
        ) VALUES (
          ${event.tenantId}::uuid,${source.packageId}::uuid,'baijiahao',
          ${policy.accountId}::uuid,'generating',false
        )
        RETURNING id,version
      `;
      const variant = variants[0];
      if (!variant) throw new Error('Baijiahao derived variant insert failed');
      const citations = await loadSourceCitations(
        transaction,
        event.tenantId,
        event.data.contentVersionId,
      );
      const writerInput = await loadWriterInput(
        transaction,
        { tenantId: event.tenantId, workspaceId: event.data.workspaceId },
        source,
        citations,
        policy.accountId,
        'official_site_derived',
      );
      const inputHash = sha256(JSON.stringify({ source_hash: source.contentHash, writerInput }));
      const requestId = boundedRequestId(`baijiahao-adapt-${event.eventId}`);
      const generationRuns = await transaction<{ id: string }[]>`
        INSERT INTO generation_runs (
          tenant_id,workspace_id,project_id,package_id,variant_id,
          skill_name,skill_version,prompt_version_id,model_key,input_hash,request_id
        ) VALUES (
          ${event.tenantId}::uuid,${event.data.workspaceId}::uuid,
          ${event.data.projectId}::uuid,${source.packageId}::uuid,${variant.id}::uuid,
          'content-writer',${this.config.writerSkillVersion},
          ${this.config.writerPromptVersionId}::uuid,${this.config.rewriteModelKey},
          ${inputHash},${requestId}
        )
        RETURNING id
      `;
      const generationRunId = requiredId(
        generationRuns[0]?.id,
        'Baijiahao adaptation generation run insert failed',
      );
      const provenance = {
        citation_ids: citations.map((citation) => citation.citationId),
        schema_version: 'baijiahao-source-provenance@1',
        source_content_hash: source.contentHash,
        source_url: event.data.externalUrl,
      };
      const automationRuns = await transaction<{ id: string }[]>`
        INSERT INTO baijiahao_automation_runs (
          tenant_id,policy_id,source_mode,source_content_version_id,
          source_publish_job_id,source_url,source_provenance_json,variant_id,status
        ) VALUES (
          ${event.tenantId}::uuid,${policy.id}::uuid,'official_site_derived',
          ${event.data.contentVersionId}::uuid,${event.data.jobId}::uuid,
          ${event.data.externalUrl},${JSON.stringify(provenance)}::text::jsonb,
          ${variant.id}::uuid,'adaptation_pending'
        )
        RETURNING id
      `;
      const automationRunId = requiredId(
        automationRuns[0]?.id,
        'Baijiahao automation run insert failed',
      );
      await this.attachDailyItem(
        transaction,
        event,
        policy,
        automationRunId,
        variant.id,
        source.briefId,
        source.packageId,
      );
      const adaptationEvent = createEvent(
        event.tenantId,
        'content.variant.baijiahao_adaptation_requested.v1',
        'content_variant',
        variant.id,
        {
          actor_user_id: policy.createdBy,
          adaptation_attempt: 0,
          automation_run_id: automationRunId,
          content_version_id: event.data.contentVersionId,
          generation_run_id: generationRunId,
          package_id: source.packageId,
          project_id: event.data.projectId,
          request_id: requestId,
          source_content_version_id: event.data.contentVersionId,
          variant_id: variant.id,
          workspace_id: event.data.workspaceId,
        },
      );
      await insertOutbox(transaction, adaptationEvent);
      await insertAudit(transaction, event, policy.createdBy, variant.id, 'created', {
        automation_run_id: automationRunId,
        source_content_version_id: event.data.contentVersionId,
        source_url: event.data.externalUrl,
      });
      void writerInput;
      return { disposition: 'processed' } as const;
    });
  }

  public async runAdaptation(
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<{ readonly disposition: 'completed' | 'processed' }> {
    const event = validateBaijiahaoAdaptationEvent(raw);
    const claim = await this.claimAdaptation(event);
    if (!claim) return { disposition: 'completed' };
    try {
      const rewritten = await this.writer.rewriteBaijiahaoVariant({
        context: adaptationContext(event, claim),
        ...(claim.currentContent ? { currentContent: claim.currentContent } : {}),
        issues: claim.issues,
        requestId: `baijiahao-adapt-${event.eventId}`,
        ...(signal ? { signal } : {}),
        sourceContent: claim.sourceContent,
        sourceMode: claim.sourceMode,
        writerInput: claim.writerInput,
      });
      await this.saveAdaptation(event, claim, rewritten);
      return { disposition: 'processed' };
    } catch (error) {
      const terminal = await this.releaseFailedAdaptation(event, claim, error);
      if (terminal) return { disposition: 'processed' };
      throw error;
    }
  }

  public loadGatePolicy(
    client: AutomationSql,
    tenantId: string,
    variantId: string,
  ): Promise<BaijiahaoAutomationPolicy | null> {
    return this.loadPolicy(client, tenantId, variantId);
  }

  public calculateGate(
    policy: BaijiahaoAutomationPolicy,
    result: QualityCheckerData,
    geoScores: QualityGeoScores,
  ): BaijiahaoQualityGate {
    const blockingRules = new Set(
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
    if (policy.sourceSimilarity !== null && policy.sourceSimilarity >= policy.maxSourceSimilarity) {
      blockingRules.add('deterministic.baijiahao.source_similarity');
    }
    if (result.decision !== 'pass') blockingRules.add(`quality.decision.${result.decision}`);
    return Object.freeze({
      blocking_rules: Object.freeze([...blockingRules].sort()),
      ...values,
      passed: blockingRules.size === 0,
      schema_version: 'baijiahao-quality-gate@1',
      source_similarity: policy.sourceSimilarity,
    });
  }

  public async advanceAfterQuality(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    policy: BaijiahaoAutomationPolicy,
    reportId: string,
    gate: BaijiahaoQualityGate,
    result: QualityCheckerData,
  ): Promise<void> {
    const rows = await transaction<{ id: string; rewriteCount: number; version: number }[]>`
      SELECT id,rewrite_count AS "rewriteCount",version
      FROM baijiahao_automation_runs
      WHERE tenant_id=${event.tenantId}::uuid AND policy_id=${policy.id}::uuid
        AND variant_id=${event.data.variantId}::uuid
        AND content_version_id=${event.data.contentVersionId}::uuid
        AND status='quality_pending'
      FOR UPDATE
    `;
    const run = rows[0];
    if (!run) return;
    if (gate.passed) {
      await this.schedulePublication(transaction, event, policy, run, reportId);
      return;
    }
    if (event.data.validationMode === 'manual_edit') {
      const error = {
        blocking_rules: gate.blocking_rules,
        code: 'MANUAL_EDIT_QUALITY_FAILED',
        schema_version: 'baijiahao-automation-error@1',
        source_publish_job_id: event.data.sourcePublishJobId,
      };
      await transaction`
        UPDATE baijiahao_automation_runs SET
          status='manual_required',last_quality_report_id=${reportId}::uuid,
          last_error_json=${JSON.stringify(error)}::text::jsonb,
          finished_at=now(),version=version+1
        WHERE id=${run.id}::uuid AND tenant_id=${event.tenantId}::uuid
          AND version=${run.version}
      `;
      await transaction`
        UPDATE baijiahao_daily_batch_items SET
          status='manual_required',last_error_json=${JSON.stringify(error)}::text::jsonb
        WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${run.id}::uuid
      `;
      return;
    }
    if (run.rewriteCount >= policy.maxRewrites) {
      const error = {
        blocking_rules: gate.blocking_rules,
        code: 'QUALITY_GATE_FAILED_AFTER_MAX_REWRITES',
        schema_version: 'baijiahao-automation-error@1',
      };
      await transaction`
        UPDATE baijiahao_automation_runs SET
          status='manual_required',last_quality_report_id=${reportId}::uuid,
          last_error_json=${JSON.stringify(error)}::text::jsonb,
          finished_at=now(),version=version+1
        WHERE id=${run.id}::uuid AND tenant_id=${event.tenantId}::uuid
          AND version=${run.version}
      `;
      await transaction`
        UPDATE baijiahao_daily_batch_items SET
          status='manual_required',last_error_json=${JSON.stringify(error)}::text::jsonb
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
    const failure = {
      code: 'QUALITY_CHECK_EXECUTION_FAILED',
      message: safeError(error),
      schema_version: 'baijiahao-automation-error@1',
      ...(event.data.validationMode === 'manual_edit'
        ? { source_publish_job_id: event.data.sourcePublishJobId }
        : {}),
    };
    const runs = await transaction<{ id: string }[]>`
      UPDATE baijiahao_automation_runs SET
        status='manual_required',last_error_json=${JSON.stringify(failure)}::text::jsonb,
        finished_at=now(),version=version+1
      WHERE tenant_id=${event.tenantId}::uuid AND variant_id=${event.data.variantId}::uuid
        AND content_version_id=${event.data.contentVersionId}::uuid
        AND status='quality_pending'
      RETURNING id
    `;
    const run = runs[0];
    if (!run) return;
    await transaction`
      UPDATE baijiahao_daily_batch_items SET
        status='manual_required',last_error_json=${JSON.stringify(failure)}::text::jsonb
      WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${run.id}::uuid
    `;
  }

  private async recordSkippedSource(
    transaction: postgres.TransactionSql,
    event: ValidatedPublishingPublishedEvent,
    policyId: string,
    reason: string,
    sourceContent: GeneratedContent,
  ): Promise<void> {
    await transaction`
      INSERT INTO baijiahao_automation_runs (
        tenant_id,policy_id,source_mode,source_content_version_id,
        source_publish_job_id,source_url,source_provenance_json,status,finished_at
      ) VALUES (
        ${event.tenantId}::uuid,${policyId}::uuid,'official_site_derived',
        ${event.data.contentVersionId}::uuid,${event.data.jobId}::uuid,
        ${event.data.externalUrl},${JSON.stringify({
          reason,
          schema_version: 'baijiahao-source-provenance@1',
          source_content_hash: contentHash(sourceContent),
        })}::text::jsonb,'skipped',now()
      )
      ON CONFLICT (tenant_id,policy_id,source_content_version_id)
        WHERE source_mode='official_site_derived'
      DO NOTHING
    `;
  }

  private async attachDailyItem(
    transaction: postgres.TransactionSql,
    event: ValidatedPublishingPublishedEvent,
    policy: SourcePolicyRow,
    automationRunId: string,
    variantId: string,
    briefId: string,
    packageId: string,
  ): Promise<void> {
    const batches = await transaction<{ id: string }[]>`
      INSERT INTO baijiahao_daily_batches (
        tenant_id,policy_id,business_date,attempt_no,status
      )
      VALUES (
        ${event.tenantId}::uuid,${policy.id}::uuid,
        (now() AT TIME ZONE 'Asia/Shanghai')::date,
        COALESCE((
          SELECT max(existing.attempt_no)
          FROM baijiahao_daily_batches AS existing
          WHERE existing.tenant_id=${event.tenantId}::uuid
            AND existing.policy_id=${policy.id}::uuid
            AND existing.business_date=(now() AT TIME ZONE 'Asia/Shanghai')::date
        ),1),'running'
      )
      ON CONFLICT (tenant_id,policy_id,business_date,attempt_no) DO UPDATE SET
        policy_id=EXCLUDED.policy_id
      RETURNING id
    `;
    const batchId = requiredId(batches[0]?.id, 'Baijiahao daily batch insert failed');
    const numbers = await transaction<{ candidateNo: number }[]>`
      SELECT COALESCE(max(candidate_no),0)::integer+1 AS "candidateNo"
      FROM baijiahao_daily_batch_items
      WHERE tenant_id=${event.tenantId}::uuid AND batch_id=${batchId}::uuid
    `;
    const candidateNo = numbers[0]?.candidateNo ?? 1;
    await transaction`
      INSERT INTO baijiahao_daily_batch_items (
        tenant_id,batch_id,candidate_no,automation_run_id,source_content_version_id,
        brief_id,package_id,variant_id,status
      ) VALUES (
        ${event.tenantId}::uuid,${batchId}::uuid,${candidateNo},${automationRunId}::uuid,
        ${event.data.contentVersionId}::uuid,${briefId}::uuid,${packageId}::uuid,
        ${variantId}::uuid,'adapting'
      )
    `;
  }

  private claimAdaptation(
    event: ValidatedBaijiahaoAdaptationEvent,
  ): Promise<AdaptationClaim | null> {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<
        {
          actorUserId: string;
          automationError: unknown;
          automationVersion: number;
          currentContent: unknown;
          currentContentHash: string;
          modelKey: string;
          packageId: string;
          projectId: string;
          promptVersionId: string;
          runStatus: string;
          runVersion: number;
          skillVersion: string;
          sourceContent: unknown;
          sourceMode: 'independent' | 'official_site_derived';
          variantStatus: string;
          variantVersion: number;
          workspaceId: string;
        }[]
      >`
        SELECT
          policy.created_by AS "actorUserId",automation.last_error_json AS "automationError",
          automation.version AS "automationVersion",current.content_json AS "currentContent",
          current.content_hash AS "currentContentHash",generation.model_key AS "modelKey",
          package.id AS "packageId",package.project_id AS "projectId",
          generation.prompt_version_id AS "promptVersionId",generation.status AS "runStatus",
          generation.version AS "runVersion",generation.skill_version AS "skillVersion",
          source.content_json AS "sourceContent",automation.source_mode AS "sourceMode",
          variant.status AS "variantStatus",
          variant.version AS "variantVersion",package.workspace_id AS "workspaceId"
        FROM baijiahao_automation_runs AS automation
        JOIN baijiahao_automation_policies AS policy
          ON policy.id=automation.policy_id AND policy.tenant_id=automation.tenant_id
        JOIN content_variants AS variant
          ON variant.id=automation.variant_id AND variant.tenant_id=automation.tenant_id
          AND variant.platform_code='baijiahao'
        JOIN content_packages AS package
          ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
          AND package.deleted_at IS NULL
        JOIN content_versions AS source
          ON source.id=COALESCE(
            automation.source_content_version_id,
            ${event.data.sourceContentVersionId}::uuid
          )
          AND source.tenant_id=automation.tenant_id
        JOIN content_versions AS current
          ON current.id=${event.data.contentVersionId}::uuid
          AND current.tenant_id=automation.tenant_id
        JOIN generation_runs AS generation
          ON generation.id=${event.data.generationRunId}::uuid
          AND generation.tenant_id=automation.tenant_id
          AND generation.variant_id=automation.variant_id
        WHERE automation.id=${event.data.automationRunId}::uuid
          AND automation.tenant_id=${event.tenantId}::uuid
          AND (
            (automation.source_mode='official_site_derived'
              AND automation.source_content_version_id=${event.data.sourceContentVersionId}::uuid)
            OR (automation.source_mode='independent'
              AND ${event.data.sourceContentVersionId}::uuid=automation.content_version_id)
          )
          AND automation.rewrite_count=${event.data.adaptationAttempt}
          AND automation.status=${event.data.adaptationAttempt === 0 ? 'adaptation_pending' : 'rewrite_pending'}
          AND (
            (${event.data.adaptationAttempt}=0 AND current.id=automation.source_content_version_id)
            OR (${event.data.adaptationAttempt}>0 AND current.id=automation.content_version_id)
          )
          AND generation.status='queued'
          AND generation.package_id=${event.data.packageId}::uuid
          AND generation.project_id=${event.data.projectId}::uuid
          AND generation.workspace_id=${event.data.workspaceId}::uuid
          AND policy.enabled
          AND variant.status=${event.data.adaptationAttempt === 0 ? 'generating' : 'quality_failed'}
        FOR UPDATE OF automation,generation,variant
      `;
      const row = rows[0];
      if (!row) return null;
      const citations = await loadSourceCitations(
        transaction,
        event.tenantId,
        event.data.sourceContentVersionId,
      );
      const source = await transaction<SourceRow[]>`
        SELECT
          brief.id AS "briefId",brief.title,brief.objective,brief.audience,
          brief.constraints_json AS constraints,package.id AS "packageId",
          source.content_json AS content,source.content_hash AS "contentHash"
        FROM content_packages AS package
        JOIN briefs AS brief ON brief.id=package.brief_id AND brief.tenant_id=package.tenant_id
        JOIN content_versions AS source
          ON source.id=${event.data.sourceContentVersionId}::uuid
          AND source.tenant_id=package.tenant_id AND source.package_id=package.id
        WHERE package.id=${event.data.packageId}::uuid AND package.tenant_id=${event.tenantId}::uuid
      `;
      const sourceRow = source[0];
      if (!sourceRow) throw new Error('Baijiahao source context is missing');
      const policyRows = await transaction<{ accountId: string }[]>`
        SELECT account_id AS "accountId" FROM baijiahao_automation_policies
        WHERE id=(
          SELECT policy_id FROM baijiahao_automation_runs
          WHERE id=${event.data.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
        ) AND tenant_id=${event.tenantId}::uuid
      `;
      const writerInput = await loadWriterInput(
        transaction,
        { tenantId: event.tenantId, workspaceId: event.data.workspaceId },
        sourceRow,
        citations,
        requiredId(policyRows[0]?.accountId, 'Baijiahao policy account is missing'),
        row.sourceMode,
      );
      const generation = await transaction<{ version: number }[]>`
        UPDATE generation_runs SET
          status='running',started_at=COALESCE(started_at,now()),finished_at=NULL,
          error_json=NULL,version=version+1
        WHERE id=${event.data.generationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='queued' AND version=${row.runVersion}
        RETURNING version
      `;
      const runVersion = generation[0]?.version;
      if (!runVersion) throw new Error('Baijiahao adaptation generation lease was lost');
      let variantVersion = row.variantVersion;
      if (event.data.adaptationAttempt > 0) {
        const variants = await transaction<{ version: number }[]>`
          UPDATE content_variants SET status='generating',version=version+1
          WHERE id=${event.data.variantId}::uuid AND tenant_id=${event.tenantId}::uuid
            AND status='quality_failed' AND version=${row.variantVersion}
          RETURNING version
        `;
        variantVersion = requiredNumber(
          variants[0]?.version,
          'Baijiahao adaptation variant lease was lost',
        );
      }
      const automations = await transaction<{ version: number }[]>`
        UPDATE baijiahao_automation_runs SET
          status=${event.data.adaptationAttempt === 0 ? 'adapting' : 'rewriting'},
          version=version+1
        WHERE id=${event.data.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND version=${row.automationVersion}
        RETURNING version
      `;
      const automationVersion = requiredNumber(
        automations[0]?.version,
        'Baijiahao automation lease was lost',
      );
      return Object.freeze({
        actorUserId: row.actorUserId,
        automationVersion,
        ...(event.data.adaptationAttempt > 0
          ? { currentContent: validateGeneratedContent(row.currentContent, 'baijiahao') }
          : {}),
        currentContentHash: row.currentContentHash,
        issues: extractPromptIssues(row.automationError),
        modelKey: row.modelKey,
        packageId: row.packageId,
        projectId: row.projectId,
        promptVersionId: row.promptVersionId,
        runVersion,
        skillVersion: row.skillVersion,
        sourceContent: validateGeneratedContent(
          row.sourceContent,
          row.sourceMode === 'official_site_derived' ? 'official_site' : 'baijiahao',
        ),
        sourceMode: row.sourceMode,
        variantVersion,
        workspaceId: row.workspaceId,
        writerInput,
      });
    });
  }

  private async saveAdaptation(
    event: ValidatedBaijiahaoAdaptationEvent,
    claim: AdaptationClaim,
    rewritten: GeneratedContent,
  ): Promise<void> {
    await this.client.begin(async (transaction) => {
      const content = validateGeneratedContent(rewritten, 'baijiahao');
      const synthetic = generationEventForAdaptation(event, claim);
      const versionId = await insertGeneratedVersion(
        transaction,
        synthetic,
        event.data.variantId,
        event.data.generationRunId,
        content,
      );
      const similarity =
        claim.sourceMode === 'official_site_derived'
          ? sourceSimilarity(claim.sourceContent, content)
          : null;
      const hash = contentHash(content);
      const variants = await transaction<{ id: string }[]>`
        UPDATE content_variants SET
          current_content_version_id=${versionId}::uuid,status='generated',quality_score=NULL,
          version=version+1
        WHERE id=${event.data.variantId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='generating' AND version=${claim.variantVersion}
        RETURNING id
      `;
      if (variants.length !== 1) throw new Error('Baijiahao adaptation is no longer current');
      const runs = await transaction<{ id: string }[]>`
        UPDATE generation_runs SET
          status='succeeded',finished_at=now(),error_json=NULL,version=version+1
        WHERE id=${event.data.generationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='running' AND version=${claim.runVersion}
        RETURNING id
      `;
      if (runs.length !== 1) throw new Error('Baijiahao adaptation generation lease was lost');
      const automations = await transaction<{ id: string }[]>`
        UPDATE baijiahao_automation_runs SET
          content_version_id=${versionId}::uuid,status='quality_pending',
          source_similarity=${similarity},last_error_json=NULL,version=version+1
        WHERE id=${event.data.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status IN ('adapting','rewriting') AND version=${claim.automationVersion}
        RETURNING id
      `;
      if (automations.length !== 1) throw new Error('Baijiahao automation lease was lost');
      await transaction`
        UPDATE baijiahao_daily_batch_items SET
          status='quality_check',content_version_id=${versionId}::uuid,last_error_json=NULL
        WHERE tenant_id=${event.tenantId}::uuid
          AND automation_run_id=${event.data.automationRunId}::uuid
      `;
      await this.enqueueQuality(transaction, {
        actorUserId: claim.actorUserId,
        contentHash: hash,
        contentVersionId: versionId,
        packageId: event.data.packageId,
        projectId: event.data.projectId,
        requestId: boundedRequestId(`baijiahao-quality-${event.eventId}`),
        tenantId: event.tenantId,
        variantId: event.data.variantId,
        workspaceId: event.data.workspaceId,
      });
      await insertAudit(transaction, event, claim.actorUserId, event.data.variantId, 'adapted', {
        content_version_id: versionId,
        rewrite_attempt: event.data.adaptationAttempt,
        source_similarity: similarity,
      });
    });
  }

  private releaseFailedAdaptation(
    event: ValidatedBaijiahaoAdaptationEvent,
    claim: AdaptationClaim,
    error: unknown,
  ): Promise<boolean> {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<{ lastError: unknown }[]>`
        SELECT last_error_json AS "lastError" FROM baijiahao_automation_runs
        WHERE id=${event.data.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status IN ('adapting','rewriting') AND version=${claim.automationVersion}
        FOR UPDATE
      `;
      const previous = record(rows[0]?.lastError) ? rows[0].lastError : {};
      const previousFailures = Number(previous['worker_failures']);
      const failures = Number.isSafeInteger(previousFailures) ? previousFailures + 1 : 1;
      const retryable = !record(error) || error['retryable'] !== false;
      const terminal = !retryable || failures >= 3;
      await transaction`
        UPDATE generation_runs SET
          status=${terminal ? 'failed' : 'queued'},
          error_json=${JSON.stringify({
            code: 'BAIJIAHAO_ADAPTATION_FAILED',
            message: safeError(error),
          })}::text::jsonb,
          started_at=${terminal ? transaction`started_at` : transaction`NULL`},
          finished_at=${terminal ? transaction`now()` : transaction`NULL`},version=version+1
        WHERE id=${event.data.generationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='running' AND version=${claim.runVersion}
      `;
      await transaction`
        UPDATE content_variants SET
          status=${event.data.adaptationAttempt === 0 && terminal ? 'generation_failed' : 'quality_failed'},
          version=version+1
        WHERE id=${event.data.variantId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='generating' AND version=${claim.variantVersion}
      `;
      const failure = {
        code: terminal ? 'ADAPTATION_EXECUTION_FAILED' : 'ADAPTATION_EXECUTION_RETRY',
        message: safeError(error),
        prompt_issues: extractPromptIssues(previous),
        retryable,
        schema_version: 'baijiahao-automation-error@1',
        worker_failures: failures,
      };
      await transaction`
        UPDATE baijiahao_automation_runs SET
          status=${
            terminal
              ? 'manual_required'
              : event.data.adaptationAttempt === 0
                ? 'adaptation_pending'
                : 'rewrite_pending'
          },
          last_error_json=${JSON.stringify(failure)}::text::jsonb,
          finished_at=${terminal ? transaction`now()` : transaction`NULL`},version=version+1
        WHERE id=${event.data.automationRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status IN ('adapting','rewriting') AND version=${claim.automationVersion}
      `;
      if (terminal) {
        await transaction`
          UPDATE baijiahao_daily_batch_items SET
            status='manual_required',last_error_json=${JSON.stringify(failure)}::text::jsonb
          WHERE tenant_id=${event.tenantId}::uuid
            AND automation_run_id=${event.data.automationRunId}::uuid
        `;
      }
      return terminal;
    });
  }

  private async loadPolicy(
    client: AutomationSql,
    tenantId: string,
    variantId: string,
  ): Promise<BaijiahaoAutomationPolicy | null> {
    const rows = await client<
      (Omit<BaijiahaoAutomationPolicy, 'sourceSimilarity'> & {
        currentContent: unknown;
        sourceContent: unknown | null;
        sourceMode: 'independent' | 'official_site_derived';
      })[]
    >`
      SELECT
        policy.id,policy.account_id AS "accountId",policy.created_by AS "createdBy",
        policy.geo_total_min AS "geoTotalMin",
        policy.factual_accuracy_min AS "factualAccuracyMin",
        policy.brand_consistency_min AS "brandConsistencyMin",
        policy.readability_safety_min AS "readabilitySafetyMin",
        policy.question_coverage_min AS "questionCoverageMin",
        policy.platform_fit_min AS "platformFitMin",policy.max_rewrites AS "maxRewrites",
        policy.publish_attempt_limit AS "publishAttemptLimit",
        policy.max_source_similarity::float8 AS "maxSourceSimilarity",
        policy.daily_schedule_times::text[] AS "scheduleTimes",
        automation.source_mode AS "sourceMode",source.content_json AS "sourceContent",
        current.content_json AS "currentContent"
      FROM baijiahao_automation_policies AS policy
      JOIN baijiahao_automation_runs AS automation
        ON automation.policy_id=policy.id AND automation.tenant_id=policy.tenant_id
        AND automation.variant_id=${variantId}::uuid
      JOIN content_variants AS variant
        ON variant.id=automation.variant_id AND variant.tenant_id=automation.tenant_id
        AND variant.current_content_version_id IS NOT NULL
      JOIN content_versions AS current
        ON current.id=variant.current_content_version_id AND current.tenant_id=variant.tenant_id
      LEFT JOIN content_versions AS source
        ON source.id=automation.source_content_version_id
        AND source.tenant_id=automation.tenant_id
      JOIN platform_accounts AS account
        ON account.id=policy.account_id AND account.tenant_id=policy.tenant_id
        AND account.workspace_id=policy.workspace_id AND account.platform_code='baijiahao'
        AND account.status='active' AND account.publish_mode='api' AND account.deleted_at IS NULL
      WHERE policy.tenant_id=${tenantId}::uuid AND policy.enabled
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    const { currentContent, sourceContent, sourceMode, ...policy } = row;
    return Object.freeze({
      ...policy,
      sourceSimilarity:
        sourceMode === 'official_site_derived'
          ? sourceSimilarity(
              validateGeneratedContent(sourceContent, 'official_site'),
              validateGeneratedContent(currentContent, 'baijiahao'),
            )
          : null,
    });
  }

  private async enqueueQuality(
    transaction: postgres.TransactionSql,
    input: QualityQueueInput,
  ): Promise<void> {
    const runs = await transaction<{ id: string }[]>`
      INSERT INTO generation_runs (
        tenant_id,workspace_id,project_id,package_id,variant_id,
        skill_name,skill_version,prompt_version_id,model_key,input_hash,request_id
      ) VALUES (
        ${input.tenantId}::uuid,${input.workspaceId}::uuid,${input.projectId}::uuid,
        ${input.packageId}::uuid,${input.variantId}::uuid,'quality-checker',
        ${this.config.qualitySkillVersion},${this.config.qualityPromptVersionId}::uuid,
        ${this.config.qualityModelKey},
        ${qualityEvaluationInputHash(input.contentHash, this.config)},${input.requestId}
      )
      RETURNING id
    `;
    const generationRunId = requiredId(runs[0]?.id, 'Baijiahao quality run insert failed');
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

  private async handoffGeneratedQuality(
    transaction: postgres.TransactionSql,
    input: GenerationQualityHandoff,
  ): Promise<void> {
    const changed = await transaction<{ id: string }[]>`
      UPDATE baijiahao_automation_runs SET
        content_version_id=${input.contentVersionId}::uuid,status='quality_pending',
        source_similarity=${input.sourceSimilarity},rewrite_count=0,
        last_quality_report_id=NULL,publish_job_id=NULL,last_error_json=NULL,
        finished_at=NULL,version=version+1
      WHERE id=${input.automationRunId}::uuid AND tenant_id=${input.tenantId}::uuid
        AND version=${input.automationVersion}
      RETURNING id
    `;
    if (changed.length !== 1) throw new Error('Baijiahao generation quality handoff was lost');
    await transaction`
      UPDATE baijiahao_daily_batch_items SET
        status='quality_check',content_version_id=${input.contentVersionId}::uuid,
        last_error_json=NULL
      WHERE tenant_id=${input.tenantId}::uuid
        AND automation_run_id=${input.automationRunId}::uuid
    `;
    await this.enqueueQuality(transaction, input);
  }

  private async enqueueRewrite(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    policy: BaijiahaoAutomationPolicy,
    run: { readonly id: string; readonly rewriteCount: number; readonly version: number },
    reportId: string,
    gate: BaijiahaoQualityGate,
    issues: readonly QualityIssue[],
  ): Promise<void> {
    const attempt = run.rewriteCount + 1;
    const promptIssues = buildBaijiahaoRewriteDiagnostics(policy, gate, issues);
    const inputHash = sha256(
      JSON.stringify({ attempt, content_version_id: event.data.contentVersionId, promptIssues }),
    );
    const requestId = boundedRequestId(`baijiahao-rewrite-${run.id}-${attempt}`);
    const generationRuns = await transaction<{ id: string }[]>`
      INSERT INTO generation_runs (
        tenant_id,workspace_id,project_id,package_id,variant_id,
        skill_name,skill_version,prompt_version_id,model_key,input_hash,request_id
      ) VALUES (
        ${event.tenantId}::uuid,${event.data.workspaceId}::uuid,
        ${event.data.projectId}::uuid,${event.data.packageId}::uuid,
        ${event.data.variantId}::uuid,'content-writer',${this.config.writerSkillVersion},
        ${this.config.writerPromptVersionId}::uuid,${this.config.rewriteModelKey},
        ${inputHash},${requestId}
      )
      RETURNING id
    `;
    const generationRunId = requiredId(
      generationRuns[0]?.id,
      'Baijiahao rewrite generation run insert failed',
    );
    const changed = await transaction<{ sourceContentVersionId: string }[]>`
      UPDATE baijiahao_automation_runs SET
        status='rewrite_pending',rewrite_count=${attempt},
        last_quality_report_id=${reportId}::uuid,
        last_error_json=${JSON.stringify({
          blocking_rules: gate.blocking_rules,
          prompt_issues: promptIssues,
          schema_version: 'baijiahao-automation-error@1',
          worker_failures: 0,
        })}::text::jsonb,version=version+1
      WHERE id=${run.id}::uuid AND tenant_id=${event.tenantId}::uuid
        AND version=${run.version}
      RETURNING COALESCE(
        source_content_version_id,
        ${event.data.contentVersionId}::uuid
      ) AS "sourceContentVersionId"
    `;
    const sourceContentVersionId = requiredId(
      changed[0]?.sourceContentVersionId,
      'Baijiahao automation run lease was lost',
    );
    await transaction`
      UPDATE baijiahao_daily_batch_items SET status='rewriting'
      WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${run.id}::uuid
    `;
    const rewriteEvent = createEvent(
      event.tenantId,
      'content.variant.baijiahao_adaptation_requested.v1',
      'content_variant',
      event.data.variantId,
      {
        actor_user_id: event.data.actorUserId,
        adaptation_attempt: attempt,
        automation_run_id: run.id,
        content_version_id: event.data.contentVersionId,
        generation_run_id: generationRunId,
        package_id: event.data.packageId,
        project_id: event.data.projectId,
        request_id: requestId,
        source_content_version_id: sourceContentVersionId,
        variant_id: event.data.variantId,
        workspace_id: event.data.workspaceId,
      },
    );
    await insertOutbox(transaction, rewriteEvent);
  }

  private async schedulePublication(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    policy: BaijiahaoAutomationPolicy,
    run: { readonly id: string; readonly version: number },
    reportId: string,
  ): Promise<void> {
    await transaction`
      SELECT id FROM baijiahao_automation_policies
      WHERE id=${policy.id}::uuid AND tenant_id=${event.tenantId}::uuid
      FOR UPDATE
    `;
    const occupiedRows = await transaction<{ scheduledAt: Date }[]>`
      SELECT job.scheduled_at AS "scheduledAt"
      FROM baijiahao_automation_runs AS automation
      JOIN publish_jobs AS job
        ON job.id=automation.publish_job_id AND job.tenant_id=automation.tenant_id
        AND job.status IN ('scheduled','publishing','published')
      WHERE automation.tenant_id=${event.tenantId}::uuid
        AND automation.policy_id=${policy.id}::uuid
        AND job.scheduled_at >= date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai')
          AT TIME ZONE 'Asia/Shanghai'
    `;
    const scheduledAt = nextBaijiahaoScheduleAt(
      new Date(),
      policy.scheduleTimes,
      occupiedRows.map((row) => row.scheduledAt),
    );
    const idempotencyKey = `baijiahao:${event.data.variantId}:${event.data.contentVersionId}`;
    const jobs = await transaction<{ id: string; version: number }[]>`
      INSERT INTO publish_jobs (
        tenant_id,variant_id,content_version_id,account_id,scheduled_at,
        idempotency_key,payload_hash,status,created_by,origin
      ) VALUES (
        ${event.tenantId}::uuid,${event.data.variantId}::uuid,
        ${event.data.contentVersionId}::uuid,${policy.accountId}::uuid,${scheduledAt},
        ${idempotencyKey},${event.data.contentHash},'scheduled',
        ${policy.createdBy}::uuid,'baijiahao_automation'
      )
      ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET
        idempotency_key=EXCLUDED.idempotency_key
      RETURNING id,version
    `;
    const job = jobs[0];
    if (!job) throw new Error('Baijiahao publish job insert failed');
    const variants = await transaction<{ id: string }[]>`
      UPDATE content_variants SET status='scheduled',version=version+1
      WHERE tenant_id=${event.tenantId}::uuid AND id=${event.data.variantId}::uuid
        AND current_content_version_id=${event.data.contentVersionId}::uuid
        AND status='quality_passed'
      RETURNING id
    `;
    if (variants.length !== 1) throw new Error('Baijiahao variant is not ready to publish');
    const changed = await transaction<{ id: string }[]>`
      UPDATE baijiahao_automation_runs SET
        status='scheduled',last_quality_report_id=${reportId}::uuid,
        publish_job_id=${job.id}::uuid,last_error_json=NULL,version=version+1
      WHERE id=${run.id}::uuid AND tenant_id=${event.tenantId}::uuid
        AND version=${run.version}
      RETURNING id
    `;
    if (changed.length !== 1) throw new Error('Baijiahao automation run lease was lost');
    await transaction`
      UPDATE baijiahao_daily_batch_items SET
        status='scheduled',content_version_id=${event.data.contentVersionId}::uuid,
        publish_job_id=${job.id}::uuid,scheduled_at=${scheduledAt},qualified_at=now(),
        last_error_json=NULL
      WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${run.id}::uuid
    `;
    await transaction`
      UPDATE baijiahao_daily_batches AS batch SET
        status=CASE WHEN (
          SELECT count(*) FROM baijiahao_daily_batches AS day_batch
          JOIN baijiahao_daily_batch_items AS qualified
            ON qualified.batch_id=day_batch.id AND qualified.tenant_id=day_batch.tenant_id
          WHERE day_batch.tenant_id=batch.tenant_id AND day_batch.policy_id=batch.policy_id
            AND day_batch.business_date=batch.business_date
            AND qualified.status IN ('scheduled','processing','published','publish_failed')
        ) >= policy.daily_target_count THEN 'scheduled' ELSE 'running' END,
        scheduled_at=CASE WHEN (
          SELECT count(*) FROM baijiahao_daily_batches AS day_batch
          JOIN baijiahao_daily_batch_items AS qualified
            ON qualified.batch_id=day_batch.id AND qualified.tenant_id=day_batch.tenant_id
          WHERE day_batch.tenant_id=batch.tenant_id AND day_batch.policy_id=batch.policy_id
            AND day_batch.business_date=batch.business_date
            AND qualified.status IN ('scheduled','processing','published','publish_failed')
        ) >= policy.daily_target_count THEN COALESCE(scheduled_at,now()) ELSE scheduled_at END,
        version=batch.version+1
      FROM baijiahao_automation_policies AS policy
      WHERE batch.tenant_id=${event.tenantId}::uuid AND batch.status='running'
        AND policy.id=batch.policy_id AND policy.tenant_id=batch.tenant_id
        AND EXISTS (
          SELECT 1 FROM baijiahao_daily_batch_items AS item
          WHERE item.tenant_id=batch.tenant_id AND item.batch_id=batch.id
            AND item.automation_run_id=${run.id}::uuid
        )
    `;
    const publishEvent = createEvent(
      event.tenantId,
      'publishing.job.execution_requested.v1',
      'publish_job',
      job.id,
      {
        job_id: job.id,
        job_version: job.version,
        request_id: boundedRequestId(`baijiahao-publish-${run.id}`),
        scheduled_at: scheduledAt.toISOString(),
      },
    );
    await insertOutbox(transaction, publishEvent, scheduledAt);
  }
}

function qualityEvaluationInputHash(
  contentHashValue: string,
  config: OfficialSiteAutomationConfig,
): string {
  return sha256(
    qualityEvaluationFingerprintSource({
      contentHash: contentHashValue,
      modelKey: config.qualityModelKey,
      promptVersionId: config.qualityPromptVersionId,
      skillVersion: config.qualitySkillVersion,
    }),
  );
}

async function loadWriterInput(
  transaction: postgres.TransactionSql,
  scope: WriterInputScope,
  source: SourceRow,
  citations: readonly WriterCitation[],
  accountId: string,
  sourceMode: 'independent' | 'official_site_derived',
): Promise<JsonObject> {
  const [brands, rules, accounts] = await Promise.all([
    transaction<{ id: string; profile: JsonObject; version: number }[]>`
      SELECT id,profile_json AS profile,version FROM brand_profiles
      WHERE tenant_id=${scope.tenantId}::uuid AND workspace_id=${scope.workspaceId}::uuid
        AND status='published'
      ORDER BY version DESC LIMIT 1
    `,
    transaction<{ hash: string; id: string; rules: JsonObject }[]>`
      SELECT id,content_hash AS hash,rules_json AS rules FROM platform_rule_versions
      WHERE platform_code='baijiahao' AND status='published'
      ORDER BY published_at DESC NULLS LAST,created_at DESC,id DESC LIMIT 1
    `,
    transaction<{ capabilities: JsonObject; displayName: string; timezone: string }[]>`
      SELECT capabilities_json AS capabilities,display_name AS "displayName",timezone
      FROM platform_accounts
      WHERE id=${accountId}::uuid AND tenant_id=${scope.tenantId}::uuid
        AND platform_code='baijiahao' AND status='active' AND publish_mode='api'
        AND deleted_at IS NULL
    `,
  ]);
  const brand = brands[0];
  const rule = rules[0];
  const account = accounts[0];
  if (!brand || !rule || !account) {
    throw new Error('Baijiahao adaptation prerequisites are missing');
  }
  const constraints = {
    ...source.constraints,
    additional_instructions:
      sourceMode === 'official_site_derived'
        ? '基于已发布官网文章做百家号同源派生。只能复用给定事实、证据和核心观点；不得重新选题、重新检索或新增事实。删除 FAQ、Schema.org、SEO 元字段、官网外链、二维码、电话、外部账号和导流 CTA。'
        : '这是百家号独立内容的质量重写。保留原选题，只使用给定品牌资料和引用证据修复质量报告；不得重新检索或新增事实，且不得包含外链、二维码、电话、外部账号或导流 CTA。',
    cta: null,
    schema_version: 'brief-constraints@1',
    target_accounts_by_code: {
      baijiahao: {
        account_id: accountId,
        capabilities: account.capabilities,
        display_name: account.displayName,
        timezone: account.timezone,
      },
    },
  };
  return {
    brief: {
      audience: source.audience,
      brief_id: source.briefId,
      constraints,
      objective: source.objective,
      platform_codes: ['baijiahao'],
      title: source.title,
    },
    citations: citations.map((citation) => ({
      chunk_id: citation.chunkId,
      citation_id: citation.citationId,
      quote_text: citation.quoteText,
      source_id: citation.sourceId,
    })),
    generation_mode: 'adapt',
    locked_blocks: [],
    platform_rules_by_code: {
      baijiahao: {
        rules: rule.rules,
        rules_hash: rule.hash,
        version_id: rule.id,
      },
    },
    strategy: {
      brand_profile_id: brand.id,
      profile: brand.profile,
      version: brand.version,
    },
  };
}

function loadSourceCitations(
  transaction: postgres.TransactionSql,
  tenantId: string,
  contentVersionId: string,
): Promise<WriterCitation[]> {
  return transaction<WriterCitation[]>`
    SELECT
      citation.id AS "citationId",citation.chunk_id AS "chunkId",
      citation.quote_text AS "quoteText",source.id AS "sourceId"
    FROM ai_citations AS citation
    JOIN source_chunks AS chunk
      ON chunk.id=citation.chunk_id AND chunk.tenant_id=citation.tenant_id
      AND chunk.status='active'
    JOIN source_documents AS source
      ON source.id=chunk.source_document_id AND source.tenant_id=chunk.tenant_id
      AND source.status='active' AND source.deleted_at IS NULL
    WHERE citation.tenant_id=${tenantId}::uuid
      AND citation.content_version_id=${contentVersionId}::uuid
    ORDER BY citation.claim_key,citation.id
  `;
}

export function assessBaijiahaoSourceSuitability(
  content: GeneratedContent,
  objective: string,
): string | null {
  if (!['awareness', 'education', 'trust'].includes(objective))
    return 'objective_not_informational';
  const text = contentText(content);
  if (readableCharacters(text) < 850) return 'source_too_short';
  const marketingMatches =
    text.match(/立即(?:下单|咨询|联系)|免费报价|服务热线|点击咨询|扫码|加微信/gu) ?? [];
  if (marketingMatches.length >= 2) return 'source_too_promotional';
  const substantiveBlocks = content.blocks.filter(
    (block) => block.block_type !== 'cta' && block.block_type !== 'media' && block.text.trim(),
  );
  return substantiveBlocks.length >= 5 ? null : 'source_structure_insufficient';
}

export function sourceSimilarity(source: GeneratedContent, derived: GeneratedContent): number {
  const left = ngrams(normalizeContent(contentText(source)), 3);
  const right = ngrams(normalizeContent(contentText(derived)), 3);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;
  const union = left.size + right.size - intersection;
  return Math.round((intersection / Math.max(1, union)) * 10_000) / 10_000;
}

export function buildBaijiahaoRewriteDiagnostics(
  policy: BaijiahaoAutomationPolicy,
  gate: BaijiahaoQualityGate,
  issues: readonly QualityIssue[],
): readonly string[] {
  const diagnostics = issues.map((issue) =>
    [
      `质量问题 ${issue.severity} ${issue.rule_id}`,
      `位置：${issue.location ?? '未指定'}`,
      `问题：${issue.message}`,
      issue.suggestion ? `修改建议：${issue.suggestion}` : '',
      unsupportedFactRewriteInstruction(issue),
    ]
      .filter(Boolean)
      .join('；'),
  );
  for (const rule of gate.blocking_rules) {
    if (rule === 'deterministic.baijiahao.source_similarity') {
      diagnostics.push(
        `来源相似度为 ${gate.source_similarity ?? '未知'}，必须低于 ${policy.maxSourceSimilarity}。重新组织标题、段落顺序、论证路径和信息重点，不能逐句近义词替换；不得改变事实和证据。`,
      );
    } else if (rule === 'gate.question_coverage') {
      diagnostics.push(
        `问题覆盖分为 ${gate.question_coverage}，最低要求 ${policy.questionCoverageMin}。把标题自然改成与正文一致的明确问题式标题，例如含“如何、怎么、哪些、是否、方法、指南”或问号；标题仍须控制在百家号 2—40 字范围内，不得虚构或填充正文没有回答的问题。`,
      );
    } else if (rule.startsWith('gate.')) {
      diagnostics.push(`未通过冻结门禁 ${rule}，必须针对本次质量报告修复，不得虚构或填充。`);
    }
  }
  return Object.freeze(diagnostics.slice(0, 50));
}

function unsupportedFactRewriteInstruction(issue: QualityIssue): string {
  if (
    !issue.rule_id.startsWith('deterministic.fact.unsupported_') &&
    !issue.rule_id.startsWith('fact.external_claim.unsupported') &&
    !issue.rule_id.startsWith('fact.high_risk.unsupported')
  ) {
    return '';
  }
  return '执行要求：仅当现有输入证据能直接支持该事实时才可保留；否则删除命中数值或整项声明。不得只改标点、运算符、数字写法或同义词后保留同一事实。';
}

function generationEventForAdaptation(
  event: ValidatedBaijiahaoAdaptationEvent,
  claim: AdaptationClaim,
): ValidatedGenerationEvent {
  return Object.freeze({
    data: Object.freeze({
      actorUserId: claim.actorUserId,
      inputHash: claim.currentContentHash,
      masterRunId: event.data.generationRunId,
      modelKey: claim.modelKey,
      modelPolicy: 'quality' as const,
      packageId: event.data.packageId,
      projectId: event.data.projectId,
      promptVersionId: claim.promptVersionId,
      requestId: event.data.requestId,
      skillVersion: claim.skillVersion,
      variantRuns: Object.freeze([
        Object.freeze({
          platformCode: 'baijiahao' as const,
          runId: event.data.generationRunId,
          variantId: event.data.variantId,
        }),
      ]),
      workspaceId: event.data.workspaceId,
      writerInput: claim.writerInput,
    }),
    eventId: event.eventId,
    occurredAt: new Date().toISOString(),
    tenantId: event.tenantId,
  });
}

function adaptationContext(
  event: ValidatedBaijiahaoAdaptationEvent,
  claim: AdaptationClaim,
): ContentWriterRunContext {
  return Object.freeze({
    batchKey: event.data.generationRunId,
    inputHash: claim.currentContentHash,
    modelKey: claim.modelKey,
    modelPolicy: 'quality',
    packageId: event.data.packageId,
    projectId: event.data.projectId,
    promptVersionId: claim.promptVersionId,
    runId: event.data.generationRunId,
    skillName: 'content-writer',
    skillVersion: claim.skillVersion,
    tenantId: event.tenantId,
    variantId: event.data.variantId,
    workspaceId: event.data.workspaceId,
  });
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
  nextAttemptAt?: Date,
): Promise<void> {
  await transaction`
    INSERT INTO outbox_events (
      id,tenant_id,event_type,aggregate_type,aggregate_id,payload_json,next_attempt_at
    ) VALUES (
      ${event.event_id}::uuid,${event.tenant.id}::uuid,${event.event_type},
      ${event.aggregate.type},${event.aggregate.id}::uuid,
      ${JSON.stringify(event)}::text::jsonb,${nextAttemptAt ?? new Date()}
    )
  `;
}

async function insertAudit(
  transaction: postgres.TransactionSql,
  event: { readonly data: { readonly requestId: string }; readonly tenantId: string },
  actorId: string,
  variantId: string,
  action: string,
  after: Readonly<Record<string, unknown>>,
): Promise<void> {
  await transaction`
    INSERT INTO audit_events (
      tenant_id,actor_id,action,resource_type,resource_id,after_json,request_id
    ) VALUES (
      ${event.tenantId}::uuid,${actorId}::uuid,${`baijiahao.automation.${action}`},
      'content_variant',${variantId}::uuid,${JSON.stringify(after)}::text::jsonb,
      ${event.data.requestId}
    )
  `;
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

export function nextBaijiahaoScheduleAt(
  now: Date,
  values: readonly string[],
  occupied: readonly Date[] = [],
): Date {
  const times = values
    .map((value) => /^(\d{2}):(\d{2})/u.exec(value))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({ hour: Number(match[1]), minute: Number(match[2]) }))
    .sort((left, right) => left.hour * 60 + left.minute - (right.hour * 60 + right.minute));
  if (times.length === 0) return now;
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  const occupiedTimes = new Set(occupied.map((value) => value.getTime()));
  for (let dayOffset = 0; dayOffset <= 31; dayOffset += 1) {
    for (const time of times) {
      const candidate = new Date(
        Date.UTC(
          shanghai.getUTCFullYear(),
          shanghai.getUTCMonth(),
          shanghai.getUTCDate() + dayOffset,
          time.hour - 8,
          time.minute,
        ),
      );
      if (candidate > now && !occupiedTimes.has(candidate.getTime())) return candidate;
    }
  }
  throw new Error('No Baijiahao schedule slot is available in the next 31 days');
}

function extractPromptIssues(value: unknown): readonly string[] {
  const source = record(value) ? value['prompt_issues'] : [];
  return Array.isArray(source)
    ? source.filter((item): item is string => typeof item === 'string').slice(0, 50)
    : [];
}

function contentText(content: GeneratedContent): string {
  return [
    typeof content['title'] === 'string' ? content['title'] : '',
    typeof content['summary'] === 'string' ? content['summary'] : '',
    ...content.blocks.map((block) => block.text),
  ].join('\n');
}

function readableCharacters(value: string): number {
  return value.replace(/[\s\p{P}\p{S}]/gu, '').length;
}

function normalizeContent(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function ngrams(value: string, size: number): Set<string> {
  const characters = [...value];
  const grams = new Set<string>();
  for (let index = 0; index <= characters.length - size; index += 1) {
    grams.add(characters.slice(index, index + size).join(''));
  }
  return grams;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedRequestId(value: string): string {
  return value.length <= 80 ? value : value.slice(0, 80);
}

function requiredId(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function requiredNumber(value: number | undefined, message: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(message);
  return Number(value);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Baijiahao automation failed').slice(0, 2_000);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
