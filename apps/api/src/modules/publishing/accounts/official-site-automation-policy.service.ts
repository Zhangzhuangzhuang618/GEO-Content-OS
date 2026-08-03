import type {
  OfficialSiteAutomationPolicyRequest,
  OfficialSiteAutomationPolicyView,
  OfficialSiteDailyBatchCancelRequest,
  OfficialSiteDailyBatchRestartRequest,
} from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import { resolveDatabaseClient, type DatabaseClientSource } from '../../../database/index.js';
import { PlatformAccountError } from './platform-account.errors.js';
import type { PlatformAccountAudit, PlatformAccountScope } from './platform-account.types.js';

interface PolicyRow {
  readonly accountId: string;
  readonly batchAttemptNo: number | null;
  readonly attemptedCount: number | null;
  readonly batchBusinessDate: Date | string | null;
  readonly batchLastErrorMessage: string | null;
  readonly batchRestartAllowed: boolean | null;
  readonly batchStatus:
    'attention_required' | 'cancelled' | 'completed' | 'running' | 'scheduled' | null;
  readonly batchVersion: number | null;
  readonly brandConsistencyMin: 90;
  readonly dailyCandidateLimit: 30;
  readonly dailyEnabled: boolean;
  readonly dailyGenerationTime: '00:00:00';
  readonly dailyScheduleTimes: readonly [
    '08:00:00',
    '09:30:00',
    '11:00:00',
    '12:30:00',
    '14:00:00',
    '15:30:00',
    '17:00:00',
    '18:30:00',
    '20:00:00',
    '21:30:00',
  ];
  readonly dailyTargetCount: 10;
  readonly dailyTimezone: 'Asia/Shanghai';
  readonly enabled: boolean;
  readonly factualAccuracyMin: 90;
  readonly geoTotalMin: 85;
  readonly id: string;
  readonly inProgressCount: number | null;
  readonly maxRewrites: 3;
  readonly platformFitMin: 80;
  readonly projectId: string;
  readonly publishedCount: number | null;
  readonly publishAttemptLimit: 3;
  readonly queuedCount: number | null;
  readonly qualifiedCount: number | null;
  readonly questionCoverageMin: 80;
  readonly readabilitySafetyMin: 85;
  readonly retiredCount: number | null;
  readonly runningCount: number | null;
  readonly scheduledCount: number | null;
  readonly tenantId: string;
  readonly updatedAt: Date | string;
  readonly version: number;
  readonly workspaceId: string;
}

export class OfficialSiteAutomationPolicyService {
  public constructor(private readonly databaseSource: DatabaseClientSource) {}

  private get database() {
    return resolveDatabaseClient(this.databaseSource);
  }

  public async list(
    scope: PlatformAccountScope,
    accountId: string,
  ): Promise<readonly OfficialSiteAutomationPolicyView[]> {
    await this.requireAccount(this.database, scope, accountId, false);
    const rows = await this.database<PolicyRow[]>`
      SELECT
        policy.id, policy.tenant_id AS "tenantId", policy.workspace_id AS "workspaceId",
        policy.project_id AS "projectId", policy.account_id AS "accountId", policy.enabled,
        policy.daily_enabled AS "dailyEnabled",
        policy.daily_target_count AS "dailyTargetCount",
        policy.daily_candidate_limit AS "dailyCandidateLimit",
        policy.daily_generation_time::text AS "dailyGenerationTime",
        policy.daily_timezone AS "dailyTimezone",
        policy.daily_schedule_times::text[] AS "dailyScheduleTimes",
        policy.geo_total_min AS "geoTotalMin",
        policy.factual_accuracy_min AS "factualAccuracyMin",
        policy.brand_consistency_min AS "brandConsistencyMin",
        policy.readability_safety_min AS "readabilitySafetyMin",
        policy.question_coverage_min AS "questionCoverageMin",
        policy.platform_fit_min AS "platformFitMin", policy.max_rewrites AS "maxRewrites",
        policy.publish_attempt_limit AS "publishAttemptLimit", policy.version,
        policy.updated_at AS "updatedAt",
        today.attempt_no AS "batchAttemptNo",
        today.business_date AS "batchBusinessDate", today.status AS "batchStatus",
        today.version AS "batchVersion",
        today.last_error_message AS "batchLastErrorMessage",
        today.restart_allowed AS "batchRestartAllowed",
        today.attempted_count AS "attemptedCount",
        today.in_progress_count AS "inProgressCount",
        today.queued_count AS "queuedCount",
        today.running_count AS "runningCount",
        today.qualified_count AS "qualifiedCount",
        today.scheduled_count AS "scheduledCount",
        today.published_count AS "publishedCount",
        today.retired_count AS "retiredCount"
      FROM official_site_automation_policies AS policy
      LEFT JOIN LATERAL (
        SELECT
          batch.attempt_no, batch.business_date, batch.status, batch.version,
          COALESCE(batch.last_error_json->>'message', batch.last_error_json->>'code')
            AS last_error_message,
          (
            (
              batch.status='attention_required'
              AND batch.last_error_json->>'code'='DAILY_CANDIDATE_LIMIT_REACHED'
            )
            OR (
              batch.status='cancelled'
              AND batch.last_error_json->>'code'='DAILY_BATCH_MANUALLY_CANCELLED'
            )
          ) AS restart_allowed,
          count(item.id)::integer AS attempted_count,
          count(item.id) FILTER (
            WHERE item.status IN ('generating','quality_check','rewriting','media_pending')
          )::integer AS in_progress_count,
          count(item.id) FILTER (
            WHERE item.status IN ('generating','quality_check','rewriting','media_pending')
              AND (
                (
                  item.status<>'media_pending'
                  AND NOT EXISTS (
                    SELECT 1 FROM generation_runs AS run
                    WHERE run.tenant_id=item.tenant_id
                      AND run.package_id=item.package_id AND run.status='running'
                  )
                ) OR (
                  item.status='media_pending'
                  AND EXISTS (
                    SELECT 1 FROM content_media_runs AS media
                    WHERE media.tenant_id=item.tenant_id AND media.variant_id=item.variant_id
                      AND media.content_version_id=item.content_version_id
                      AND media.status='queued'
                  )
                )
              )
          )::integer AS queued_count,
          count(item.id) FILTER (
            WHERE item.status IN ('generating','quality_check','rewriting','media_pending')
              AND (
                (
                  item.status<>'media_pending'
                  AND EXISTS (
                    SELECT 1 FROM generation_runs AS run
                    WHERE run.tenant_id=item.tenant_id
                      AND run.package_id=item.package_id AND run.status='running'
                  )
                ) OR (
                  item.status='media_pending'
                  AND EXISTS (
                    SELECT 1 FROM content_media_runs AS media
                    WHERE media.tenant_id=item.tenant_id AND media.variant_id=item.variant_id
                      AND media.content_version_id=item.content_version_id
                      AND media.status='running'
                  )
                )
              )
          )::integer AS running_count,
          count(item.id) FILTER (
            WHERE item.status IN ('qualified','scheduled','published','publish_failed','reserve')
          )::integer AS qualified_count,
          count(item.id) FILTER (
            WHERE item.status IN ('scheduled','published','publish_failed')
          )::integer AS scheduled_count,
          count(item.id) FILTER (WHERE item.status='published')::integer AS published_count,
          count(item.id) FILTER (WHERE item.status='retired')::integer AS retired_count
        FROM official_site_daily_batches AS batch
        LEFT JOIN official_site_daily_batch_items AS item
          ON item.batch_id=batch.id AND item.tenant_id=batch.tenant_id
        WHERE batch.tenant_id=policy.tenant_id AND batch.policy_id=policy.id
          AND batch.business_date=(now() AT TIME ZONE policy.daily_timezone)::date
        GROUP BY batch.id
        ORDER BY batch.attempt_no DESC
        LIMIT 1
      ) AS today ON true
      WHERE policy.tenant_id=${scope.tenantId}::uuid AND policy.account_id=${accountId}::uuid
        AND has_project_scope_access(
          policy.tenant_id,policy.workspace_id,policy.project_id,${scope.userId}::uuid
        )
      ORDER BY policy.project_id
    `;
    return Object.freeze(rows.map(mapPolicy));
  }

  public update(
    scope: PlatformAccountScope,
    accountId: string,
    input: OfficialSiteAutomationPolicyRequest,
    audit: PlatformAccountAudit,
  ): Promise<OfficialSiteAutomationPolicyView> {
    return this.database.begin(async (transaction) => {
      const account = await this.requireAccount(transaction, scope, accountId, true);
      const projects = await transaction<{ id: string }[]>`
        SELECT id FROM projects
        WHERE id=${input.project_id}::uuid AND tenant_id=${scope.tenantId}::uuid
          AND workspace_id=${account.workspaceId}::uuid AND status='active' AND deleted_at IS NULL
          AND has_project_scope_access(
            tenant_id,workspace_id,id,${scope.userId}::uuid
          )
        FOR UPDATE
      `;
      if (projects.length !== 1) throw notFound();
      if (input.enabled && (account.status !== 'active' || account.publishMode !== 'api')) {
        throw stateInvalid('Only an active official-site API account can enable automation');
      }
      if (input.daily_enabled && !input.enabled) {
        throw stateInvalid('Daily publishing requires official-site automation to be enabled');
      }
      const existing = await transaction<PolicyRow[]>`
        SELECT
          id, tenant_id AS "tenantId", workspace_id AS "workspaceId",
          project_id AS "projectId", account_id AS "accountId", enabled,
          daily_enabled AS "dailyEnabled", daily_target_count AS "dailyTargetCount",
          daily_candidate_limit AS "dailyCandidateLimit",
          daily_generation_time::text AS "dailyGenerationTime",
          daily_timezone AS "dailyTimezone",
          daily_schedule_times::text[] AS "dailyScheduleTimes",
          geo_total_min AS "geoTotalMin", factual_accuracy_min AS "factualAccuracyMin",
          brand_consistency_min AS "brandConsistencyMin",
          readability_safety_min AS "readabilitySafetyMin",
          question_coverage_min AS "questionCoverageMin", platform_fit_min AS "platformFitMin",
          max_rewrites AS "maxRewrites", publish_attempt_limit AS "publishAttemptLimit",
          version, updated_at AS "updatedAt",
          NULL::smallint AS "batchAttemptNo", NULL::date AS "batchBusinessDate",
          NULL::text AS "batchStatus", NULL::integer AS "batchVersion",
          NULL::text AS "batchLastErrorMessage", NULL::integer AS "attemptedCount",
          NULL::boolean AS "batchRestartAllowed",
          NULL::integer AS "inProgressCount", NULL::integer AS "queuedCount",
          NULL::integer AS "runningCount", NULL::integer AS "qualifiedCount",
          NULL::integer AS "scheduledCount", NULL::integer AS "publishedCount",
          NULL::integer AS "retiredCount"
        FROM official_site_automation_policies
        WHERE tenant_id=${scope.tenantId}::uuid AND project_id=${input.project_id}::uuid
        FOR UPDATE
      `;
      const before = existing[0];
      if (before && input.expected_version !== before.version) throw versionConflict();
      if (!before && input.expected_version !== undefined) throw versionConflict();
      const dailyEnabled = input.enabled
        ? (input.daily_enabled ?? before?.dailyEnabled ?? false)
        : false;
      const rows = await transaction<PolicyRow[]>`
        INSERT INTO official_site_automation_policies (
          tenant_id,workspace_id,project_id,account_id,enabled,daily_enabled,created_by
        ) VALUES (
          ${scope.tenantId}::uuid,${account.workspaceId}::uuid,${input.project_id}::uuid,
          ${accountId}::uuid,${input.enabled},${dailyEnabled},${scope.userId}::uuid
        )
        ON CONFLICT (tenant_id,project_id) DO UPDATE SET
          account_id=EXCLUDED.account_id, enabled=EXCLUDED.enabled,
          daily_enabled=EXCLUDED.daily_enabled,
          version=official_site_automation_policies.version+1
        RETURNING
          id,tenant_id AS "tenantId",workspace_id AS "workspaceId",project_id AS "projectId",
          account_id AS "accountId",enabled,daily_enabled AS "dailyEnabled",
          daily_target_count AS "dailyTargetCount",
          daily_candidate_limit AS "dailyCandidateLimit",
          daily_generation_time::text AS "dailyGenerationTime",
          daily_timezone AS "dailyTimezone",
          daily_schedule_times::text[] AS "dailyScheduleTimes",
          geo_total_min AS "geoTotalMin",
          factual_accuracy_min AS "factualAccuracyMin",
          brand_consistency_min AS "brandConsistencyMin",
          readability_safety_min AS "readabilitySafetyMin",
          question_coverage_min AS "questionCoverageMin",platform_fit_min AS "platformFitMin",
          max_rewrites AS "maxRewrites",publish_attempt_limit AS "publishAttemptLimit",
          version,updated_at AS "updatedAt",
          NULL::smallint AS "batchAttemptNo", NULL::date AS "batchBusinessDate",
          NULL::text AS "batchStatus", NULL::integer AS "batchVersion",
          NULL::text AS "batchLastErrorMessage", NULL::integer AS "attemptedCount",
          NULL::boolean AS "batchRestartAllowed",
          NULL::integer AS "inProgressCount", NULL::integer AS "queuedCount",
          NULL::integer AS "runningCount", NULL::integer AS "qualifiedCount",
          NULL::integer AS "scheduledCount", NULL::integer AS "publishedCount",
          NULL::integer AS "retiredCount"
      `;
      const after = rows[0];
      if (!after) throw stateInvalid('Automation policy was not saved');
      await transaction`
        INSERT INTO audit_events (
          tenant_id,actor_id,action,resource_type,resource_id,
          before_json,after_json,ip,request_id
        ) VALUES (
          ${scope.tenantId}::uuid,${scope.userId}::uuid,
          'official_site.automation_policy.updated','official_site_automation_policy',
          ${after.id}::uuid,
          ${before ? jsonbText(transaction, mapPolicy(before)) : null}::jsonb,
          ${jsonbText(transaction, mapPolicy(after))}::jsonb,
          ${audit.ip ?? null},${audit.requestId}
        )
      `;
      return mapPolicy(after);
    });
  }

  public async restartDailyBatchInTransaction(
    transaction: TransactionSql,
    scope: PlatformAccountScope,
    accountId: string,
    input: OfficialSiteDailyBatchRestartRequest,
    audit: PlatformAccountAudit,
  ): Promise<OfficialSiteAutomationPolicyView> {
    const account = await this.requireAccount(transaction, scope, accountId, true);
    if (account.status !== 'active' || account.publishMode !== 'api') {
      throw stateInvalid('Only an active official-site API account can restart a daily batch');
    }
    const policies = await transaction<
      {
        dailyEnabled: boolean;
        enabled: boolean;
        id: string;
        timezone: string;
        workspaceId: string;
      }[]
    >`
      SELECT
        policy.id,policy.workspace_id AS "workspaceId",policy.enabled,
        policy.daily_enabled AS "dailyEnabled",policy.daily_timezone AS timezone
      FROM official_site_automation_policies AS policy
      JOIN projects AS project
        ON project.id=policy.project_id AND project.tenant_id=policy.tenant_id
        AND project.workspace_id=policy.workspace_id
        AND project.status='active' AND project.deleted_at IS NULL
      WHERE policy.tenant_id=${scope.tenantId}::uuid
        AND policy.account_id=${accountId}::uuid
        AND policy.project_id=${input.project_id}::uuid
        AND has_project_scope_access(
          policy.tenant_id,policy.workspace_id,policy.project_id,${scope.userId}::uuid
        )
      FOR UPDATE OF policy
    `;
    const policy = policies[0];
    if (!policy) throw notFound();
    if (!policy.enabled || !policy.dailyEnabled) {
      throw stateInvalid('The daily official-site plan is not enabled');
    }
    const batches = await transaction<
      {
        attemptNo: number;
        businessDate: Date | string;
        errorCode: string | null;
        id: string;
        status: 'attention_required' | 'cancelled' | 'completed' | 'running' | 'scheduled';
        version: number;
      }[]
    >`
      SELECT
        id,attempt_no AS "attemptNo",business_date AS "businessDate",status,version,
        last_error_json->>'code' AS "errorCode"
      FROM official_site_daily_batches
      WHERE tenant_id=${scope.tenantId}::uuid AND policy_id=${policy.id}::uuid
        AND business_date=(now() AT TIME ZONE ${policy.timezone})::date
      ORDER BY attempt_no DESC
      LIMIT 1
      FOR UPDATE
    `;
    const before = batches[0];
    if (!before) throw stateInvalid('There is no daily batch to restart today');
    if (before.version !== input.expected_batch_version) throw versionConflict();
    const restartable =
      (before.status === 'attention_required' &&
        before.errorCode === 'DAILY_CANDIDATE_LIMIT_REACHED') ||
      (before.status === 'cancelled' && before.errorCode === 'DAILY_BATCH_MANUALLY_CANCELLED');
    if (!restartable) {
      throw stateInvalid(
        'Only a candidate-limit batch or a manually cancelled batch can be restarted',
      );
    }
    const cancelled = await transaction<{ version: number }[]>`
      UPDATE official_site_daily_batches SET
        status='cancelled',
        last_error_json=COALESCE(last_error_json,'{}'::jsonb) || jsonb_build_object(
          'restarted_at',now(),
          'restarted_by',${scope.userId}::uuid
        ),
        version=version+1
      WHERE id=${before.id}::uuid AND tenant_id=${scope.tenantId}::uuid
        AND status=${before.status} AND version=${before.version}
      RETURNING version
    `;
    if (!cancelled[0]) throw versionConflict();
    const created = await transaction<
      {
        attemptNo: number;
        businessDate: Date | string;
        id: string;
        version: number;
      }[]
    >`
      INSERT INTO official_site_daily_batches (
        tenant_id,policy_id,business_date,attempt_no,status
      ) VALUES (
        ${scope.tenantId}::uuid,${policy.id}::uuid,${dateOnly(before.businessDate)}::date,
        ${before.attemptNo + 1},'running'
      )
      RETURNING
        id,attempt_no AS "attemptNo",business_date AS "businessDate",version
    `;
    const next = created[0];
    if (!next) throw stateInvalid('The new daily batch was not created');
    await transaction`
      INSERT INTO audit_events (
        tenant_id,actor_id,action,resource_type,resource_id,
        before_json,after_json,ip,request_id
      ) VALUES (
        ${scope.tenantId}::uuid,${scope.userId}::uuid,
        'official_site.daily_batch.restarted','official_site_daily_batch',
        ${next.id}::uuid,
        ${jsonbText(transaction, {
          attempt_no: before.attemptNo,
          batch_id: before.id,
          status: before.status,
          version: before.version,
        })}::jsonb,
        ${jsonbText(transaction, {
          attempt_no: next.attemptNo,
          batch_id: next.id,
          restarted_from_batch_id: before.id,
          status: 'running',
          version: next.version,
        })}::jsonb,
        ${audit.ip ?? null},${audit.requestId}
      )
    `;
    const rows = await transaction<PolicyRow[]>`
      SELECT
        policy.id,policy.tenant_id AS "tenantId",policy.workspace_id AS "workspaceId",
        policy.project_id AS "projectId",policy.account_id AS "accountId",policy.enabled,
        policy.daily_enabled AS "dailyEnabled",
        policy.daily_target_count AS "dailyTargetCount",
        policy.daily_candidate_limit AS "dailyCandidateLimit",
        policy.daily_generation_time::text AS "dailyGenerationTime",
        policy.daily_timezone AS "dailyTimezone",
        policy.daily_schedule_times::text[] AS "dailyScheduleTimes",
        policy.geo_total_min AS "geoTotalMin",
        policy.factual_accuracy_min AS "factualAccuracyMin",
        policy.brand_consistency_min AS "brandConsistencyMin",
        policy.readability_safety_min AS "readabilitySafetyMin",
        policy.question_coverage_min AS "questionCoverageMin",
        policy.platform_fit_min AS "platformFitMin",
        policy.max_rewrites AS "maxRewrites",
        policy.publish_attempt_limit AS "publishAttemptLimit",
        policy.version,policy.updated_at AS "updatedAt",
        batch.attempt_no AS "batchAttemptNo",
        batch.business_date AS "batchBusinessDate",
        batch.status AS "batchStatus",batch.version AS "batchVersion",
        NULL::text AS "batchLastErrorMessage",
        false AS "batchRestartAllowed",
        0::integer AS "attemptedCount",0::integer AS "inProgressCount",
        0::integer AS "queuedCount",0::integer AS "runningCount",
        0::integer AS "qualifiedCount",0::integer AS "scheduledCount",
        0::integer AS "publishedCount",0::integer AS "retiredCount"
      FROM official_site_automation_policies AS policy
      JOIN official_site_daily_batches AS batch
        ON batch.id=${next.id}::uuid AND batch.tenant_id=policy.tenant_id
      WHERE policy.id=${policy.id}::uuid AND policy.tenant_id=${scope.tenantId}::uuid
    `;
    const result = rows[0];
    if (!result) throw stateInvalid('The restarted daily batch could not be loaded');
    return mapPolicy(result);
  }

  public async cancelDailyBatchInTransaction(
    transaction: TransactionSql,
    scope: PlatformAccountScope,
    accountId: string,
    input: OfficialSiteDailyBatchCancelRequest,
    audit: PlatformAccountAudit,
  ): Promise<OfficialSiteAutomationPolicyView> {
    await this.requireAccount(transaction, scope, accountId, true);
    const policies = await transaction<
      {
        id: string;
        timezone: string;
      }[]
    >`
      SELECT policy.id,policy.daily_timezone AS timezone
      FROM official_site_automation_policies AS policy
      JOIN projects AS project
        ON project.id=policy.project_id AND project.tenant_id=policy.tenant_id
        AND project.workspace_id=policy.workspace_id
        AND project.status='active' AND project.deleted_at IS NULL
      WHERE policy.tenant_id=${scope.tenantId}::uuid
        AND policy.account_id=${accountId}::uuid
        AND policy.project_id=${input.project_id}::uuid
        AND has_project_scope_access(
          policy.tenant_id,policy.workspace_id,policy.project_id,${scope.userId}::uuid
        )
      FOR UPDATE OF policy
    `;
    const policy = policies[0];
    if (!policy) throw notFound();
    const batches = await transaction<
      {
        attemptNo: number;
        businessDate: Date | string;
        id: string;
        status: 'attention_required' | 'cancelled' | 'completed' | 'running' | 'scheduled';
        version: number;
      }[]
    >`
      SELECT
        id,attempt_no AS "attemptNo",business_date AS "businessDate",status,version
      FROM official_site_daily_batches
      WHERE tenant_id=${scope.tenantId}::uuid AND policy_id=${policy.id}::uuid
        AND business_date=(now() AT TIME ZONE ${policy.timezone})::date
      ORDER BY attempt_no DESC
      LIMIT 1
      FOR UPDATE
    `;
    const before = batches[0];
    if (!before) throw stateInvalid('There is no daily batch to cancel today');
    if (before.version !== input.expected_batch_version) throw versionConflict();
    if (before.status !== 'running') {
      throw stateInvalid('Only a running daily batch can be cancelled');
    }
    const cancellation = {
      code: 'DAILY_BATCH_MANUALLY_CANCELLED',
      message: '今日批次已由用户手动终止，不再生成新候选或自动排期。',
      schema_version: 'official-site-daily-error@1',
    } as const;
    const cancelled = await transaction<{ version: number }[]>`
      UPDATE official_site_daily_batches SET
        status='cancelled',
        last_error_json=${JSON.stringify(cancellation)}::text::jsonb,
        version=version+1
      WHERE id=${before.id}::uuid AND tenant_id=${scope.tenantId}::uuid
        AND status='running' AND version=${before.version}
      RETURNING version
    `;
    const cancelledVersion = cancelled[0]?.version;
    if (!cancelledVersion) throw versionConflict();
    await transaction`
      UPDATE generation_runs AS run SET
        status='cancelled',
        started_at=COALESCE(run.started_at,now()),
        finished_at=COALESCE(run.finished_at,now()),
        error_json=${JSON.stringify({
          code: 'DAILY_BATCH_CANCELLED',
          message: cancellation.message,
        })}::text::jsonb,
        version=run.version+1
      WHERE run.tenant_id=${scope.tenantId}::uuid
        AND run.status IN ('queued','running')
        AND EXISTS (
          SELECT 1
          FROM official_site_daily_batch_items AS item
          WHERE item.tenant_id=run.tenant_id
            AND item.batch_id=${before.id}::uuid
            AND item.package_id=run.package_id
        )
    `;
    await transaction`
      UPDATE official_site_automation_runs AS automation SET
        status='disabled',
        last_error_json=${JSON.stringify(cancellation)}::text::jsonb,
        finished_at=now(),
        version=automation.version+1
      WHERE automation.tenant_id=${scope.tenantId}::uuid
        AND automation.status IN (
          'quality_pending','rewrite_pending','rewriting','media_pending','publish_pending'
        )
        AND EXISTS (
          SELECT 1
          FROM official_site_daily_batch_items AS item
          WHERE item.tenant_id=automation.tenant_id
            AND item.batch_id=${before.id}::uuid
            AND item.variant_id=automation.variant_id
        )
    `;
    await transaction`
      UPDATE content_media_runs AS media SET
        status='cancelled',finished_at=now(),
        last_error_json=${JSON.stringify(cancellation)}::text::jsonb,
        version=media.version+1
      WHERE media.tenant_id=${scope.tenantId}::uuid
        AND media.status IN ('queued','running')
        AND EXISTS (
          SELECT 1
          FROM official_site_daily_batch_items AS item
          WHERE item.tenant_id=media.tenant_id
            AND item.batch_id=${before.id}::uuid
            AND item.variant_id=media.variant_id
        )
    `;
    await transaction`
      UPDATE content_variants AS variant SET
        status=CASE
          WHEN variant.status='generating' AND variant.current_content_version_id IS NULL
            THEN 'generation_failed'
          WHEN variant.status='generating' THEN 'quality_failed'
          ELSE variant.status
        END,
        version=variant.version+1
      FROM official_site_daily_batch_items AS item
      WHERE item.tenant_id=${scope.tenantId}::uuid
        AND item.batch_id=${before.id}::uuid
        AND item.status IN ('generating','quality_check','rewriting','media_pending')
        AND variant.id=item.variant_id AND variant.tenant_id=item.tenant_id
        AND variant.status IN ('generating','generated','quality_failed','quality_passed')
    `;
    await transaction`
      UPDATE content_packages AS package SET
        status=CASE
          WHEN variant.status='generation_failed' THEN 'all_failed'
          WHEN variant.status IN ('generated','quality_failed','quality_passed') THEN 'generated'
          ELSE package.status
        END,
        version=package.version+1
      FROM official_site_daily_batch_items AS item
      JOIN content_variants AS variant
        ON variant.id=item.variant_id AND variant.tenant_id=item.tenant_id
      WHERE item.tenant_id=${scope.tenantId}::uuid
        AND item.batch_id=${before.id}::uuid
        AND package.id=item.package_id AND package.tenant_id=item.tenant_id
        AND package.status='generating'
        AND variant.status IN (
          'generation_failed','generated','quality_failed','quality_passed'
        )
    `;
    await transaction`
      UPDATE official_site_daily_batch_items SET
        status='retired',
        last_error_json=${JSON.stringify(cancellation)}::text::jsonb
      WHERE tenant_id=${scope.tenantId}::uuid AND batch_id=${before.id}::uuid
        AND status IN ('generating','quality_check','rewriting','media_pending')
    `;
    await transaction`
      UPDATE official_site_daily_batch_items SET status='reserve'
      WHERE tenant_id=${scope.tenantId}::uuid AND batch_id=${before.id}::uuid
        AND status='qualified'
    `;
    await transaction`
      INSERT INTO audit_events (
        tenant_id,actor_id,action,resource_type,resource_id,
        before_json,after_json,ip,request_id
      ) VALUES (
        ${scope.tenantId}::uuid,${scope.userId}::uuid,
        'official_site.daily_batch.cancelled','official_site_daily_batch',
        ${before.id}::uuid,
        ${jsonbText(transaction, {
          attempt_no: before.attemptNo,
          batch_id: before.id,
          status: before.status,
          version: before.version,
        })}::jsonb,
        ${jsonbText(transaction, {
          attempt_no: before.attemptNo,
          batch_id: before.id,
          status: 'cancelled',
          version: cancelledVersion,
        })}::jsonb,
        ${audit.ip ?? null},${audit.requestId}
      )
    `;
    const rows = await transaction<PolicyRow[]>`
      SELECT
        policy.id,policy.tenant_id AS "tenantId",policy.workspace_id AS "workspaceId",
        policy.project_id AS "projectId",policy.account_id AS "accountId",policy.enabled,
        policy.daily_enabled AS "dailyEnabled",
        policy.daily_target_count AS "dailyTargetCount",
        policy.daily_candidate_limit AS "dailyCandidateLimit",
        policy.daily_generation_time::text AS "dailyGenerationTime",
        policy.daily_timezone AS "dailyTimezone",
        policy.daily_schedule_times::text[] AS "dailyScheduleTimes",
        policy.geo_total_min AS "geoTotalMin",
        policy.factual_accuracy_min AS "factualAccuracyMin",
        policy.brand_consistency_min AS "brandConsistencyMin",
        policy.readability_safety_min AS "readabilitySafetyMin",
        policy.question_coverage_min AS "questionCoverageMin",
        policy.platform_fit_min AS "platformFitMin",
        policy.max_rewrites AS "maxRewrites",
        policy.publish_attempt_limit AS "publishAttemptLimit",
        policy.version,policy.updated_at AS "updatedAt",
        batch.attempt_no AS "batchAttemptNo",
        batch.business_date AS "batchBusinessDate",
        batch.status AS "batchStatus",batch.version AS "batchVersion",
        COALESCE(batch.last_error_json->>'message',batch.last_error_json->>'code')
          AS "batchLastErrorMessage",
        true AS "batchRestartAllowed",
        count(item.id)::integer AS "attemptedCount",
        count(item.id) FILTER (
          WHERE item.status IN ('generating','quality_check','rewriting','media_pending')
        )::integer AS "inProgressCount",
        count(item.id) FILTER (
          WHERE item.status IN ('generating','quality_check','rewriting','media_pending')
            AND (
              (
                item.status<>'media_pending'
                AND NOT EXISTS (
                  SELECT 1 FROM generation_runs AS run
                  WHERE run.tenant_id=item.tenant_id
                    AND run.package_id=item.package_id AND run.status='running'
                )
              ) OR (
                item.status='media_pending'
                AND EXISTS (
                  SELECT 1 FROM content_media_runs AS media
                  WHERE media.tenant_id=item.tenant_id AND media.variant_id=item.variant_id
                    AND media.content_version_id=item.content_version_id
                    AND media.status='queued'
                )
              )
            )
        )::integer AS "queuedCount",
        count(item.id) FILTER (
          WHERE item.status IN ('generating','quality_check','rewriting','media_pending')
            AND (
              (
                item.status<>'media_pending'
                AND EXISTS (
                  SELECT 1 FROM generation_runs AS run
                  WHERE run.tenant_id=item.tenant_id
                    AND run.package_id=item.package_id AND run.status='running'
                )
              ) OR (
                item.status='media_pending'
                AND EXISTS (
                  SELECT 1 FROM content_media_runs AS media
                  WHERE media.tenant_id=item.tenant_id AND media.variant_id=item.variant_id
                    AND media.content_version_id=item.content_version_id
                    AND media.status='running'
                )
              )
            )
        )::integer AS "runningCount",
        count(item.id) FILTER (
          WHERE item.status IN ('qualified','scheduled','published','publish_failed','reserve')
        )::integer AS "qualifiedCount",
        count(item.id) FILTER (
          WHERE item.status IN ('scheduled','published','publish_failed')
        )::integer AS "scheduledCount",
        count(item.id) FILTER (WHERE item.status='published')::integer AS "publishedCount",
        count(item.id) FILTER (WHERE item.status='retired')::integer AS "retiredCount"
      FROM official_site_automation_policies AS policy
      JOIN official_site_daily_batches AS batch
        ON batch.id=${before.id}::uuid AND batch.tenant_id=policy.tenant_id
      LEFT JOIN official_site_daily_batch_items AS item
        ON item.batch_id=batch.id AND item.tenant_id=batch.tenant_id
      WHERE policy.id=${policy.id}::uuid AND policy.tenant_id=${scope.tenantId}::uuid
      GROUP BY policy.id,batch.id
    `;
    const result = rows[0];
    if (!result) throw stateInvalid('The cancelled daily batch could not be loaded');
    return mapPolicy(result);
  }

  private async requireAccount(
    client: ReturnType<typeof resolveDatabaseClient> | TransactionSql,
    scope: PlatformAccountScope,
    accountId: string,
    lock: boolean,
  ) {
    const rows = await client<
      {
        publishMode: 'api' | 'export' | 'manual';
        status: 'active' | 'disabled' | 'reauth';
        workspaceId: string;
      }[]
    >`
      SELECT workspace_id AS "workspaceId",publish_mode AS "publishMode",status
      FROM platform_accounts
      WHERE id=${accountId}::uuid AND tenant_id=${scope.tenantId}::uuid
        AND platform_code='official_site' AND deleted_at IS NULL
        AND has_project_scope_access(tenant_id,workspace_id,NULL,${scope.userId}::uuid)
      ${lock ? client`FOR UPDATE` : client``}
    `;
    const account = rows[0];
    if (!account) throw notFound();
    return account;
  }
}

function jsonbText(transaction: TransactionSql, value: unknown) {
  return transaction.typed(JSON.stringify(value), 25);
}

function mapPolicy(row: PolicyRow): OfficialSiteAutomationPolicyView {
  return {
    account_id: row.accountId,
    brand_consistency_min: row.brandConsistencyMin,
    daily_candidate_limit: row.dailyCandidateLimit,
    daily_enabled: row.dailyEnabled,
    daily_generation_time: row.dailyGenerationTime,
    daily_schedule_times: [...row.dailyScheduleTimes],
    daily_target_count: row.dailyTargetCount,
    daily_timezone: row.dailyTimezone,
    enabled: row.enabled,
    factual_accuracy_min: row.factualAccuracyMin,
    geo_total_min: row.geoTotalMin,
    id: row.id,
    max_rewrites: row.maxRewrites,
    platform_fit_min: row.platformFitMin,
    project_id: row.projectId,
    publish_attempt_limit: row.publishAttemptLimit,
    question_coverage_min: row.questionCoverageMin,
    readability_safety_min: row.readabilitySafetyMin,
    tenant_id: row.tenantId,
    today_batch:
      row.batchBusinessDate && row.batchStatus
        ? {
            attempt_no: row.batchAttemptNo ?? 1,
            attempted_count: row.attemptedCount ?? 0,
            business_date: dateOnly(row.batchBusinessDate),
            in_progress_count: row.inProgressCount ?? 0,
            last_error_message: row.batchLastErrorMessage,
            published_count: row.publishedCount ?? 0,
            queued_count: row.queuedCount ?? 0,
            qualified_count: row.qualifiedCount ?? 0,
            restart_allowed: row.batchRestartAllowed ?? false,
            retired_count: row.retiredCount ?? 0,
            running_count: row.runningCount ?? 0,
            scheduled_count: row.scheduledCount ?? 0,
            status: row.batchStatus,
            target_count: row.dailyTargetCount,
            version: row.batchVersion ?? 1,
          }
        : null,
    updated_at: new Date(row.updatedAt).toISOString(),
    version: row.version,
    workspace_id: row.workspaceId,
  };
}

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function notFound(): PlatformAccountError {
  return new PlatformAccountError(
    'PLATFORM_ACCOUNT_NOT_FOUND',
    'Official-site account or project was not found',
  );
}

function stateInvalid(message: string): PlatformAccountError {
  return new PlatformAccountError('PLATFORM_ACCOUNT_STATE_INVALID', message);
}

function versionConflict(): PlatformAccountError {
  return new PlatformAccountError(
    'PLATFORM_ACCOUNT_VERSION_CONFLICT',
    'Automation policy version does not match',
  );
}
