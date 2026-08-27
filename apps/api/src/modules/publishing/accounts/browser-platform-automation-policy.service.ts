import type {
  BrowserPlatformAutomationPolicyRequest,
  BrowserPlatformAutomationPolicyView,
  BrowserPlatformDailyBatchRestartRequest,
  BrowserPlatformDailyBatchRetryRequest,
} from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import { resolveDatabaseClient, type DatabaseClientSource } from '../../../database/index.js';
import { PlatformAccountError } from './platform-account.errors.js';
import type { PlatformAccountAudit, PlatformAccountScope } from './platform-account.types.js';

type Platform = 'douyin' | 'lieju' | 'sohu';

interface PolicyRow {
  readonly accountId: string;
  readonly attemptedCount: number | null;
  readonly batchAttemptNo: number | null;
  readonly batchBusinessDate: Date | string | null;
  readonly batchLastErrorMessage: string | null;
  readonly batchRestartAllowed: boolean | null;
  readonly batchStatus: BrowserPlatformAutomationPolicyView['today_batch'] extends infer T
    ? T extends { status: infer S }
      ? S
      : never
    : never;
  readonly batchVersion: number | null;
  readonly dailyCandidateLimit: number;
  readonly dailyEnabled: boolean;
  readonly dailyGenerationTime: string;
  readonly dailyScheduleTimes: readonly string[];
  readonly dailyTargetCount: number;
  readonly enabled: boolean;
  readonly id: string;
  readonly inProgressCount: number | null;
  readonly manualRequiredCount: number | null;
  readonly manualItems:
    | readonly {
        readonly automation_run_id: string;
        readonly candidate_no: number;
        readonly content_version_id: string | null;
        readonly last_error: Readonly<Record<string, unknown>> | null;
        readonly package_id: string;
        readonly publish_job_id: string | null;
        readonly quality_report_id: string | null;
        readonly rewrite_count: number;
        readonly title: string | null;
        readonly updated_at: Date | string;
        readonly variant_id: string;
      }[]
    | null;
  readonly platformCode: Platform;
  readonly projectId: string;
  readonly publishedCount: number | null;
  readonly retryAllowed: boolean | null;
  readonly retiredCount: number | null;
  readonly scheduledCount: number | null;
  readonly tenantId: string;
  readonly updatedAt: Date | string;
  readonly version: number;
  readonly workspaceId: string;
}

export class BrowserPlatformAutomationPolicyService {
  public constructor(private readonly databaseSource: DatabaseClientSource) {}

  private get database() {
    return resolveDatabaseClient(this.databaseSource);
  }

  public async list(
    scope: PlatformAccountScope,
    accountId: string,
  ): Promise<readonly BrowserPlatformAutomationPolicyView[]> {
    await this.requireAccount(scope, accountId);
    return Object.freeze((await this.select(scope, accountId)).map(mapPolicy));
  }

  public update(
    scope: PlatformAccountScope,
    accountId: string,
    input: BrowserPlatformAutomationPolicyRequest,
    audit: PlatformAccountAudit,
  ): Promise<BrowserPlatformAutomationPolicyView> {
    return this.database.begin(async (transaction) => {
      const account = await this.requireAccount(scope, accountId, transaction);
      const projects = await transaction<{ id: string }[]>`
        SELECT id FROM projects
        WHERE id=${input.project_id}::uuid AND tenant_id=${scope.tenantId}::uuid
          AND workspace_id=${account.workspaceId}::uuid AND status='active' AND deleted_at IS NULL
          AND has_project_scope_access(
            tenant_id,workspace_id,id,${scope.userId}::uuid
          )
      `;
      if (!projects[0]) throw notFound();
      if (input.enabled && (account.status !== 'active' || account.publishMode !== 'api')) {
        throw stateInvalid('启用自动化需要处于正常状态的托管浏览器账号。');
      }
      const existing = await transaction<{ id: string; version: number }[]>`
        SELECT id,version FROM browser_platform_automation_policies
        WHERE tenant_id=${scope.tenantId}::uuid AND account_id=${accountId}::uuid
          AND project_id=${input.project_id}::uuid
        FOR UPDATE
      `;
      const before = existing[0];
      if (before && input.expected_version !== before.version) throw versionConflict();
      if (!before && input.expected_version !== undefined) throw versionConflict();
      const rows = await transaction<{ id: string }[]>`
        INSERT INTO browser_platform_automation_policies (
          tenant_id,workspace_id,project_id,account_id,platform_code,enabled,daily_enabled,
          daily_target_count,daily_candidate_limit,daily_generation_time,daily_schedule_times,
          created_by
        ) VALUES (
          ${scope.tenantId}::uuid,${account.workspaceId}::uuid,${input.project_id}::uuid,
          ${accountId}::uuid,${account.platformCode},${input.enabled},${input.daily_enabled},
          ${input.daily_target_count},${input.daily_candidate_limit},${input.daily_generation_time}::time,
          ${transaction.array([...input.daily_schedule_times], 1083)}::time[],${scope.userId}::uuid
        )
        ON CONFLICT (tenant_id,account_id,project_id) DO UPDATE SET
          enabled=EXCLUDED.enabled,daily_enabled=EXCLUDED.daily_enabled,
          daily_target_count=EXCLUDED.daily_target_count,
          daily_candidate_limit=EXCLUDED.daily_candidate_limit,
          daily_generation_time=EXCLUDED.daily_generation_time,
          daily_schedule_times=EXCLUDED.daily_schedule_times,version=browser_platform_automation_policies.version+1
        RETURNING id
      `;
      const policyId = rows[0]?.id;
      if (!policyId) throw stateInvalid('自动化策略保存失败。');
      await transaction`
        INSERT INTO audit_events (
          tenant_id,actor_id,action,resource_type,resource_id,before_json,after_json,request_id
        ) VALUES (
          ${scope.tenantId}::uuid,${scope.userId}::uuid,'browser_platform.automation.updated',
          'platform_account',${accountId}::uuid,
          ${before ? JSON.stringify(before) : null}::text::jsonb,
          ${JSON.stringify({
            daily_candidate_limit: input.daily_candidate_limit,
            daily_enabled: input.daily_enabled,
            daily_generation_time: input.daily_generation_time,
            daily_schedule_times: input.daily_schedule_times,
            daily_target_count: input.daily_target_count,
            enabled: input.enabled,
            platform_code: account.platformCode,
            project_id: input.project_id,
          })}::text::jsonb,${audit.requestId}
        )
      `;
      const selected = await this.select(scope, accountId, policyId, transaction);
      const policy = selected[0];
      if (!policy) throw notFound();
      return mapPolicy(policy);
    });
  }

  public async retryDailyBatchInTransaction(
    transaction: TransactionSql,
    scope: PlatformAccountScope,
    accountId: string,
    input: BrowserPlatformDailyBatchRetryRequest,
    audit: PlatformAccountAudit,
  ): Promise<BrowserPlatformAutomationPolicyView> {
    const account = await this.requireAccount(scope, accountId, transaction);
    if (account.status !== 'active' || account.publishMode !== 'api') {
      throw stateInvalid('只有正常状态的自动发布账号可以重试今日批次。');
    }
    const rows = await transaction<
      {
        attemptedCount: number;
        batchId: string;
        batchStatus: 'attention_required' | 'cancelled' | 'completed' | 'running' | 'scheduled';
        batchVersion: number;
        dailyEnabled: boolean;
        enabled: boolean;
        errorCode: string | null;
        platformCode: Platform;
        policyId: string;
      }[]
    >`
      SELECT policy.id AS "policyId",policy.platform_code AS "platformCode",
        policy.enabled,policy.daily_enabled AS "dailyEnabled",
        batch.id AS "batchId",batch.status AS "batchStatus",batch.version AS "batchVersion",
        batch.last_error_json->>'code' AS "errorCode",
        (
          SELECT count(*)::integer FROM browser_platform_daily_batch_items AS item
          WHERE item.tenant_id=batch.tenant_id AND item.batch_id=batch.id
        ) AS "attemptedCount"
      FROM browser_platform_automation_policies AS policy
      JOIN browser_platform_daily_batches AS batch
        ON batch.policy_id=policy.id AND batch.tenant_id=policy.tenant_id
        AND batch.business_date=(now() AT TIME ZONE policy.daily_timezone)::date
      WHERE policy.tenant_id=${scope.tenantId}::uuid
        AND policy.account_id=${accountId}::uuid
        AND policy.project_id=${input.project_id}::uuid
        AND has_project_scope_access(
          policy.tenant_id,policy.workspace_id,policy.project_id,${scope.userId}::uuid
        )
      ORDER BY batch.attempt_no DESC LIMIT 1
      FOR UPDATE OF policy,batch
    `;
    const before = rows[0];
    if (!before) throw stateInvalid('今天没有可重试的自动化批次。');
    if (!before.enabled || !before.dailyEnabled) {
      throw stateInvalid('请先启用自动化和每日批次。');
    }
    if (before.batchVersion !== input.expected_batch_version) throw versionConflict();
    if (
      before.batchStatus !== 'attention_required' ||
      before.errorCode !== 'AUTOMATION_PREREQUISITE_MISSING' ||
      before.attemptedCount !== 0
    ) {
      throw stateInvalid('仅可重试因前置资料缺失且尚未生成候选的今日批次。');
    }
    const updated = await transaction<{ version: number }[]>`
      UPDATE browser_platform_daily_batches SET
        status='running',last_error_json=NULL,version=version+1
      WHERE id=${before.batchId}::uuid AND tenant_id=${scope.tenantId}::uuid
        AND status='attention_required' AND version=${before.batchVersion}
      RETURNING version
    `;
    const next = updated[0];
    if (!next) throw versionConflict();
    await transaction`
      INSERT INTO audit_events (
        tenant_id,actor_id,action,resource_type,resource_id,before_json,after_json,ip,request_id
      ) VALUES (
        ${scope.tenantId}::uuid,${scope.userId}::uuid,
        'browser_platform.daily_batch.retried','browser_platform_daily_batch',
        ${before.batchId}::uuid,
        ${JSON.stringify({
          error_code: before.errorCode,
          platform_code: before.platformCode,
          status: before.batchStatus,
          version: before.batchVersion,
        })}::text::jsonb,
        ${JSON.stringify({
          platform_code: before.platformCode,
          status: 'running',
          version: next.version,
        })}::text::jsonb,
        ${audit.ip ?? null},${audit.requestId}
      )
    `;
    const selected = await this.select(scope, accountId, before.policyId, transaction);
    const policy = selected[0];
    if (!policy) throw notFound();
    return mapPolicy(policy);
  }

  public async restartDailyBatchInTransaction(
    transaction: TransactionSql,
    scope: PlatformAccountScope,
    accountId: string,
    input: BrowserPlatformDailyBatchRestartRequest,
    audit: PlatformAccountAudit,
  ): Promise<BrowserPlatformAutomationPolicyView> {
    const account = await this.requireAccount(scope, accountId, transaction);
    if (account.status !== 'active' || account.publishMode !== 'api') {
      throw stateInvalid('只有正常状态的自动发布账号可以重新发起今日批次。');
    }
    const rows = await transaction<
      {
        attemptNo: number;
        batchId: string;
        batchStatus: 'attention_required' | 'cancelled' | 'completed' | 'running' | 'scheduled';
        batchVersion: number;
        businessDate: Date | string;
        dailyEnabled: boolean;
        enabled: boolean;
        errorCode: string | null;
        platformCode: Platform;
        policyId: string;
        successfulCount: number;
        targetCount: number;
      }[]
    >`
      SELECT policy.id AS "policyId",policy.platform_code AS "platformCode",
        policy.enabled,policy.daily_enabled AS "dailyEnabled",
        policy.daily_target_count AS "targetCount",batch.id AS "batchId",
        batch.attempt_no AS "attemptNo",batch.business_date AS "businessDate",
        batch.status AS "batchStatus",batch.version AS "batchVersion",
        batch.last_error_json->>'code' AS "errorCode",
        (
          SELECT count(*)::integer
          FROM browser_platform_daily_batches AS day_batch
          JOIN browser_platform_daily_batch_items AS item
            ON item.batch_id=day_batch.id AND item.tenant_id=day_batch.tenant_id
          WHERE day_batch.tenant_id=batch.tenant_id AND day_batch.policy_id=batch.policy_id
            AND day_batch.business_date=batch.business_date
            AND item.status IN ('scheduled','processing','published','publish_failed')
        ) AS "successfulCount"
      FROM browser_platform_automation_policies AS policy
      JOIN browser_platform_daily_batches AS batch
        ON batch.policy_id=policy.id AND batch.tenant_id=policy.tenant_id
        AND batch.business_date=(now() AT TIME ZONE policy.daily_timezone)::date
      WHERE policy.tenant_id=${scope.tenantId}::uuid
        AND policy.account_id=${accountId}::uuid
        AND policy.project_id=${input.project_id}::uuid
        AND has_project_scope_access(
          policy.tenant_id,policy.workspace_id,policy.project_id,${scope.userId}::uuid
        )
      ORDER BY batch.attempt_no DESC LIMIT 1
      FOR UPDATE OF policy,batch
    `;
    const before = rows[0];
    if (!before) throw stateInvalid('今天没有可重新发起的自动化批次。');
    if (!before.enabled || !before.dailyEnabled) throw stateInvalid('请先启用自动化和每日批次。');
    if (before.batchVersion !== input.expected_batch_version) throw versionConflict();
    const restartable =
      (before.batchStatus === 'attention_required' &&
        before.errorCode === 'DAILY_CANDIDATE_LIMIT_REACHED') ||
      (before.batchStatus === 'cancelled' && before.errorCode === 'DAILY_BATCH_MANUALLY_CANCELLED');
    if (!restartable) throw stateInvalid('仅候选上限耗尽或人工终止的批次可以重新发起。');
    if (before.successfulCount >= before.targetCount) {
      throw stateInvalid('今日合格内容已达到目标；发布失败请处理原发布任务。');
    }
    const cancelled = await transaction<{ version: number }[]>`
      UPDATE browser_platform_daily_batches SET status='cancelled',
        last_error_json=COALESCE(last_error_json,'{}'::jsonb) || jsonb_build_object(
          'restarted_at',now(),'restarted_by',${scope.userId}::uuid
        ),version=version+1
      WHERE id=${before.batchId}::uuid AND tenant_id=${scope.tenantId}::uuid
        AND status=${before.batchStatus} AND version=${before.batchVersion}
      RETURNING version
    `;
    if (!cancelled[0]) throw versionConflict();
    const created = await transaction<{ id: string; attemptNo: number }[]>`
      INSERT INTO browser_platform_daily_batches (
        tenant_id,policy_id,business_date,attempt_no,status
      ) VALUES (
        ${scope.tenantId}::uuid,${before.policyId}::uuid,
        ${dateOnly(before.businessDate)}::date,${before.attemptNo + 1},'running'
      ) RETURNING id,attempt_no AS "attemptNo"
    `;
    const next = created[0];
    if (!next) throw stateInvalid('新的平台日批尝试创建失败。');
    await transaction`
      INSERT INTO audit_events (
        tenant_id,actor_id,action,resource_type,resource_id,before_json,after_json,ip,request_id
      ) VALUES (
        ${scope.tenantId}::uuid,${scope.userId}::uuid,
        'browser_platform.daily_batch.restarted','browser_platform_daily_batch',${next.id}::uuid,
        ${JSON.stringify({
          attempt_no: before.attemptNo,
          batch_id: before.batchId,
          platform_code: before.platformCode,
          retained_success_count: before.successfulCount,
          status: before.batchStatus,
        })}::text::jsonb,
        ${JSON.stringify({
          attempt_no: next.attemptNo,
          batch_id: next.id,
          missing_count: before.targetCount - before.successfulCount,
          platform_code: before.platformCode,
          restarted_from_batch_id: before.batchId,
          retained_success_count: before.successfulCount,
          status: 'running',
        })}::text::jsonb,${audit.ip ?? null},${audit.requestId}
      )
    `;
    const selected = await this.select(scope, accountId, before.policyId, transaction);
    const policy = selected[0];
    if (!policy) throw notFound();
    return mapPolicy(policy);
  }

  private select(
    scope: PlatformAccountScope,
    accountId: string,
    policyId?: string,
    client: ReturnType<typeof resolveDatabaseClient> | TransactionSql = this.database,
  ) {
    return client<PolicyRow[]>`
      SELECT
        policy.id,policy.tenant_id AS "tenantId",policy.workspace_id AS "workspaceId",
        policy.project_id AS "projectId",policy.account_id AS "accountId",
        policy.platform_code AS "platformCode",policy.enabled,
        policy.daily_enabled AS "dailyEnabled",
        policy.daily_target_count AS "dailyTargetCount",
        policy.daily_candidate_limit AS "dailyCandidateLimit",
        policy.daily_generation_time::text AS "dailyGenerationTime",
        policy.daily_schedule_times::text[] AS "dailyScheduleTimes",
        policy.version,policy.updated_at AS "updatedAt",
        batch.attempt_no AS "batchAttemptNo",
        batch.business_date AS "batchBusinessDate",batch.status AS "batchStatus",
        batch.version AS "batchVersion",batch.last_error_json->>'message' AS "batchLastErrorMessage",
        (
          (
            batch.status='attention_required'
            AND batch.last_error_json->>'code'='DAILY_CANDIDATE_LIMIT_REACHED'
          ) OR (
            batch.status='cancelled'
            AND batch.last_error_json->>'code'='DAILY_BATCH_MANUALLY_CANCELLED'
          )
        ) AND coalesce(day_counts.successful,0) < policy.daily_target_count
          AS "batchRestartAllowed",
        (
          policy.enabled AND policy.daily_enabled
          AND batch.status='attention_required'
          AND batch.last_error_json->>'code'='AUTOMATION_PREREQUISITE_MISSING'
          AND coalesce(counts.attempted,0)=0
        ) AS "retryAllowed",
        counts.attempted AS "attemptedCount",counts.in_progress AS "inProgressCount",
        counts.manual_required AS "manualRequiredCount",counts.retired AS "retiredCount",
        day_counts.scheduled AS "scheduledCount",day_counts.published AS "publishedCount",
        manual.items AS "manualItems"
      FROM browser_platform_automation_policies AS policy
      LEFT JOIN LATERAL (
        SELECT candidate.* FROM browser_platform_daily_batches AS candidate
        WHERE candidate.tenant_id=policy.tenant_id AND candidate.policy_id=policy.id
          AND candidate.business_date=(now() AT TIME ZONE policy.daily_timezone)::date
        ORDER BY candidate.attempt_no DESC LIMIT 1
      ) AS batch ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*)::integer AS attempted,
          count(*) FILTER (WHERE item.status IN (
            'generating','quality_check','rewriting','media_pending'
          ))::integer AS in_progress,
          count(*) FILTER (WHERE item.status IN ('manual_required','publish_failed'))::integer AS manual_required,
          count(*) FILTER (WHERE item.status='retired')::integer AS retired,
          count(*) FILTER (WHERE item.status IN ('scheduled','processing','published'))::integer AS scheduled,
          count(*) FILTER (WHERE item.status='published')::integer AS published
        FROM browser_platform_daily_batch_items AS item
        WHERE item.tenant_id=policy.tenant_id AND item.batch_id=batch.id
      ) AS counts ON batch.id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE item.status IN (
            'scheduled','processing','published','publish_failed'
          ))::integer AS successful,
          count(*) FILTER (WHERE item.status IN (
            'scheduled','processing','published','publish_failed'
          ))::integer AS scheduled,
          count(*) FILTER (WHERE item.status='published')::integer AS published
        FROM browser_platform_daily_batches AS day_batch
        JOIN browser_platform_daily_batch_items AS item
          ON item.batch_id=day_batch.id AND item.tenant_id=day_batch.tenant_id
        WHERE day_batch.tenant_id=policy.tenant_id AND day_batch.policy_id=policy.id
          AND day_batch.business_date=batch.business_date
      ) AS day_counts ON batch.id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object(
              'automation_run_id',run.id,
              'candidate_no',item.candidate_no,
              'content_version_id',run.content_version_id,
              'last_error',coalesce(item.last_error_json,run.last_error_json),
              'package_id',item.package_id,
              'publish_job_id',coalesce(item.publish_job_id,run.publish_job_id),
              'quality_report_id',run.last_quality_report_id,
              'rewrite_count',run.rewrite_count,
              'title',version.content_json->>'title',
              'updated_at',greatest(item.updated_at,run.updated_at),
              'variant_id',item.variant_id
            ) ORDER BY item.candidate_no
          ),
          '[]'::jsonb
        ) AS items
        FROM browser_platform_daily_batch_items AS item
        JOIN browser_platform_automation_runs AS run
          ON run.id=item.automation_run_id AND run.tenant_id=item.tenant_id
        LEFT JOIN content_versions AS version
          ON version.id=run.content_version_id AND version.tenant_id=run.tenant_id
        WHERE item.tenant_id=policy.tenant_id AND item.batch_id=batch.id
          AND item.status IN ('manual_required','publish_failed')
      ) AS manual ON batch.id IS NOT NULL
      WHERE policy.tenant_id=${scope.tenantId}::uuid AND policy.account_id=${accountId}::uuid
        AND (${policyId ?? null}::uuid IS NULL OR policy.id=${policyId ?? null}::uuid)
        AND has_project_scope_access(
          policy.tenant_id,policy.workspace_id,policy.project_id,${scope.userId}::uuid
        )
      ORDER BY policy.project_id
    `;
  }

  private async requireAccount(
    scope: PlatformAccountScope,
    accountId: string,
    client: ReturnType<typeof resolveDatabaseClient> | TransactionSql = this.database,
  ) {
    const rows = await client<
      {
        platformCode: Platform;
        publishMode: 'api' | 'export' | 'manual';
        status: 'active' | 'disabled' | 'reauth';
        workspaceId: string;
      }[]
    >`
      SELECT platform_code AS "platformCode",workspace_id AS "workspaceId",
        publish_mode AS "publishMode",status
      FROM platform_accounts
      WHERE id=${accountId}::uuid AND tenant_id=${scope.tenantId}::uuid
        AND platform_code IN ('sohu','lieju','douyin') AND deleted_at IS NULL
        AND has_project_scope_access(tenant_id,workspace_id,NULL,${scope.userId}::uuid)
    `;
    const account = rows[0];
    if (!account) throw notFound();
    return account;
  }
}

function mapPolicy(row: PolicyRow): BrowserPlatformAutomationPolicyView {
  return {
    account_id: row.accountId,
    brand_consistency_min: 90,
    daily_candidate_limit: row.dailyCandidateLimit,
    daily_enabled: row.dailyEnabled,
    daily_generation_time: row.dailyGenerationTime,
    daily_schedule_times: [...row.dailyScheduleTimes],
    daily_target_count: row.dailyTargetCount,
    daily_timezone: 'Asia/Shanghai',
    enabled: row.enabled,
    factual_accuracy_min: 90,
    geo_total_min: 85,
    id: row.id,
    max_rewrites: 3,
    platform_code: row.platformCode,
    platform_fit_min: 80,
    project_id: row.projectId,
    publish_attempt_limit: 3,
    question_coverage_min: 80,
    readability_safety_min: 85,
    tenant_id: row.tenantId,
    today_batch:
      row.batchBusinessDate && row.batchStatus && row.batchVersion
        ? {
            attempt_no: row.batchAttemptNo ?? 1,
            attempted_count: row.attemptedCount ?? 0,
            business_date: new Date(row.batchBusinessDate).toISOString().slice(0, 10),
            in_progress_count: row.inProgressCount ?? 0,
            last_error_message: row.batchLastErrorMessage,
            manual_items: (row.manualItems ?? []).map((item) => ({
              ...item,
              updated_at: new Date(item.updated_at).toISOString(),
            })),
            manual_required_count: row.manualRequiredCount ?? 0,
            published_count: row.publishedCount ?? 0,
            restart_allowed: row.batchRestartAllowed ?? false,
            retry_allowed: row.retryAllowed ?? false,
            retired_count: row.retiredCount ?? 0,
            scheduled_count: row.scheduledCount ?? 0,
            status: row.batchStatus,
            target_count: row.dailyTargetCount,
            version: row.batchVersion,
          }
        : null,
    updated_at: new Date(row.updatedAt).toISOString(),
    version: row.version,
    workspace_id: row.workspaceId,
  };
}

function notFound() {
  return new PlatformAccountError('PLATFORM_ACCOUNT_NOT_FOUND', '账号或项目不存在。');
}

function stateInvalid(message: string) {
  return new PlatformAccountError('PLATFORM_ACCOUNT_STATE_INVALID', message);
}

function versionConflict() {
  return new PlatformAccountError('PLATFORM_ACCOUNT_VERSION_CONFLICT', '自动化策略版本已变化。');
}

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}
