import type {
  BaijiahaoAutomationPolicyRequest,
  BaijiahaoAutomationPolicyView,
  BaijiahaoBrowserSessionView,
} from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import { resolveDatabaseClient } from '../../../database/index.js';
import type { DatabaseClientSource } from '../../../database/index.js';
import type { BaijiahaoBrowserGatewayClient } from './baijiahao-browser-gateway.client.js';
import { PlatformAccountError } from './platform-account.errors.js';
import type { PlatformAccountAudit, PlatformAccountScope } from './platform-account.types.js';

interface PolicyRow {
  readonly accountId: string;
  readonly attemptedCount: number | null;
  readonly batchBusinessDate: Date | string | null;
  readonly batchLastErrorMessage: string | null;
  readonly batchStatus:
    'attention_required' | 'cancelled' | 'completed' | 'running' | 'scheduled' | null;
  readonly batchVersion: number | null;
  readonly brandConsistencyMin: 90;
  readonly dailyCandidateLimit: number;
  readonly dailyEnabled: boolean;
  readonly dailyGenerationTime: string;
  readonly dailyScheduleTimes: readonly string[];
  readonly dailyTargetCount: number;
  readonly dailyTimezone: 'Asia/Shanghai';
  readonly enabled: boolean;
  readonly factualAccuracyMin: 90;
  readonly geoTotalMin: 85;
  readonly id: string;
  readonly independentFallbackEnabled: boolean;
  readonly inProgressCount: number | null;
  readonly manualRequiredCount: number | null;
  readonly maxRewrites: 3;
  readonly maxSourceSimilarity: number;
  readonly platformFitMin: 80;
  readonly projectId: string;
  readonly publishedCount: number | null;
  readonly publishAttemptLimit: 3;
  readonly questionCoverageMin: 80;
  readonly readabilitySafetyMin: 85;
  readonly scheduledCount: number | null;
  readonly sessionAccountId: string | null;
  readonly sessionAuthenticatedAt: Date | string | null;
  readonly sessionLastVerifiedAt: Date | string | null;
  readonly sessionQrExpiresAt: Date | string | null;
  readonly sessionStatus: BaijiahaoBrowserSessionView['status'] | null;
  readonly sessionVersion: number | null;
  readonly skippedCount: number | null;
  readonly sourceMode: 'independent' | 'official_site_derived';
  readonly tenantId: string;
  readonly updatedAt: Date | string;
  readonly version: number;
  readonly workspaceId: string;
}

export class BaijiahaoAutomationPolicyService {
  public constructor(
    private readonly databaseSource: DatabaseClientSource,
    private readonly gateway: BaijiahaoBrowserGatewayClient,
  ) {}

  private get database() {
    return resolveDatabaseClient(this.databaseSource);
  }

  public async list(
    scope: PlatformAccountScope,
    accountId: string,
  ): Promise<readonly BaijiahaoAutomationPolicyView[]> {
    await this.requireAccount(this.database, scope, accountId, false);
    return Object.freeze((await this.selectPolicies(scope, accountId)).map(mapPolicy));
  }

  public update(
    scope: PlatformAccountScope,
    accountId: string,
    input: BaijiahaoAutomationPolicyRequest,
    audit: PlatformAccountAudit,
  ): Promise<BaijiahaoAutomationPolicyView> {
    return this.database.begin(async (transaction) => {
      const account = await this.requireAccount(transaction, scope, accountId, true);
      const projects = await transaction<{ id: string }[]>`
        SELECT id FROM projects
        WHERE id=${input.project_id}::uuid AND tenant_id=${scope.tenantId}::uuid
          AND workspace_id=${account.workspaceId}::uuid AND status='active' AND deleted_at IS NULL
          AND has_project_scope_access(tenant_id,workspace_id,id,${scope.userId}::uuid)
        FOR UPDATE
      `;
      if (projects.length !== 1) throw notFound();
      if (input.enabled && (account.status !== 'active' || account.publishMode !== 'api')) {
        throw stateInvalid('Only an active Baijiahao API account can enable automation');
      }
      if (input.enabled) {
        const sessions = await transaction<{ status: string }[]>`
          SELECT status FROM baijiahao_browser_sessions
          WHERE tenant_id=${scope.tenantId}::uuid AND account_id=${accountId}::uuid
          FOR UPDATE
        `;
        if (sessions[0]?.status !== 'authenticated') {
          throw stateInvalid(
            'Baijiahao browser login must be authenticated before automation is enabled',
          );
        }
      }
      const existing = await transaction<{ id: string; version: number }[]>`
        SELECT id,version FROM baijiahao_automation_policies
        WHERE tenant_id=${scope.tenantId}::uuid AND project_id=${input.project_id}::uuid
        FOR UPDATE
      `;
      const before = existing[0];
      if (before && before.version !== input.expected_version) throw versionConflict();
      if (!before && input.expected_version !== undefined) throw versionConflict();
      const schedules = transaction.array(input.daily_schedule_times, 1083);
      const rows = await transaction<{ id: string }[]>`
        INSERT INTO baijiahao_automation_policies (
          tenant_id,workspace_id,project_id,account_id,enabled,source_mode,
          independent_fallback_enabled,daily_enabled,daily_target_count,
          daily_candidate_limit,daily_generation_time,daily_schedule_times,created_by
        ) VALUES (
          ${scope.tenantId}::uuid,${account.workspaceId}::uuid,${input.project_id}::uuid,
          ${accountId}::uuid,${input.enabled},${input.source_mode},
          ${input.independent_fallback_enabled},${input.daily_enabled},
          ${input.daily_target_count},${input.daily_candidate_limit},
          ${input.daily_generation_time}::time,${schedules}::time[],${scope.userId}::uuid
        )
        ON CONFLICT (tenant_id,project_id) DO UPDATE SET
          account_id=EXCLUDED.account_id,enabled=EXCLUDED.enabled,
          source_mode=EXCLUDED.source_mode,
          independent_fallback_enabled=EXCLUDED.independent_fallback_enabled,
          daily_enabled=EXCLUDED.daily_enabled,daily_target_count=EXCLUDED.daily_target_count,
          daily_candidate_limit=EXCLUDED.daily_candidate_limit,
          daily_generation_time=EXCLUDED.daily_generation_time,
          daily_schedule_times=EXCLUDED.daily_schedule_times,
          version=baijiahao_automation_policies.version+1
        RETURNING id
      `;
      const saved = rows[0];
      if (!saved) throw stateInvalid('Baijiahao automation policy was not saved');
      const views = await this.selectPolicies(scope, accountId, transaction, input.project_id);
      const after = views[0];
      if (!after) throw stateInvalid('Baijiahao automation policy was not reloaded');
      await transaction`
        INSERT INTO audit_events (
          tenant_id,actor_id,action,resource_type,resource_id,before_json,after_json,ip,request_id
        ) VALUES (
          ${scope.tenantId}::uuid,${scope.userId}::uuid,
          'baijiahao.automation_policy.updated','baijiahao_automation_policy',${saved.id}::uuid,
          ${before ? jsonbText(transaction, before) : null}::jsonb,
          ${jsonbText(transaction, mapPolicy(after))}::jsonb,
          ${audit.ip ?? null},${audit.requestId}
        )
      `;
      return mapPolicy(after);
    });
  }

  public async sessionStatus(
    scope: PlatformAccountScope,
    accountId: string,
  ): Promise<BaijiahaoBrowserSessionView> {
    await this.requireAccount(this.database, scope, accountId, false);
    return this.gateway.status(accountId);
  }

  public async startLogin(
    scope: PlatformAccountScope,
    accountId: string,
    expectedVersion: number,
  ): Promise<Awaited<ReturnType<BaijiahaoBrowserGatewayClient['login']>>> {
    const account = await this.requireAccount(this.database, scope, accountId, false);
    if (account.version !== expectedVersion) throw versionConflict();
    if (account.status === 'disabled' || account.publishMode !== 'api') {
      throw stateInvalid('Only a non-disabled Baijiahao API account can start browser login');
    }
    return this.gateway.login(accountId);
  }

  public async reauthenticate(
    scope: PlatformAccountScope,
    accountId: string,
    expectedVersion: number,
  ): Promise<Awaited<ReturnType<BaijiahaoBrowserGatewayClient['reauthenticate']>>> {
    const account = await this.requireAccount(this.database, scope, accountId, false);
    if (account.version !== expectedVersion) throw versionConflict();
    if (account.status === 'disabled' || account.publishMode !== 'api') {
      throw stateInvalid('Only a non-disabled Baijiahao API account can reauthenticate');
    }
    return this.gateway.reauthenticate(accountId);
  }

  private selectPolicies(
    scope: PlatformAccountScope,
    accountId: string,
    client: ReturnType<typeof resolveDatabaseClient> | TransactionSql = this.database,
    projectId?: string,
  ): Promise<PolicyRow[]> {
    return client<PolicyRow[]>`
      SELECT
        policy.id,policy.tenant_id AS "tenantId",policy.workspace_id AS "workspaceId",
        policy.project_id AS "projectId",policy.account_id AS "accountId",policy.enabled,
        policy.source_mode AS "sourceMode",
        policy.independent_fallback_enabled AS "independentFallbackEnabled",
        policy.daily_enabled AS "dailyEnabled",policy.daily_target_count AS "dailyTargetCount",
        policy.daily_candidate_limit AS "dailyCandidateLimit",
        policy.daily_generation_time::text AS "dailyGenerationTime",
        policy.daily_timezone AS "dailyTimezone",
        policy.daily_schedule_times::text[] AS "dailyScheduleTimes",
        policy.max_source_similarity::double precision AS "maxSourceSimilarity",
        policy.geo_total_min AS "geoTotalMin",policy.factual_accuracy_min AS "factualAccuracyMin",
        policy.brand_consistency_min AS "brandConsistencyMin",
        policy.readability_safety_min AS "readabilitySafetyMin",
        policy.question_coverage_min AS "questionCoverageMin",
        policy.platform_fit_min AS "platformFitMin",policy.max_rewrites AS "maxRewrites",
        policy.publish_attempt_limit AS "publishAttemptLimit",policy.version,
        policy.updated_at AS "updatedAt",
        session.account_id AS "sessionAccountId",session.status AS "sessionStatus",
        session.qr_expires_at AS "sessionQrExpiresAt",
        session.authenticated_at AS "sessionAuthenticatedAt",
        session.last_verified_at AS "sessionLastVerifiedAt",session.version AS "sessionVersion",
        today.business_date AS "batchBusinessDate",today.status AS "batchStatus",
        today.version AS "batchVersion",today.last_error_message AS "batchLastErrorMessage",
        today.attempted_count AS "attemptedCount",today.in_progress_count AS "inProgressCount",
        today.scheduled_count AS "scheduledCount",today.published_count AS "publishedCount",
        today.skipped_count AS "skippedCount",
        today.manual_required_count AS "manualRequiredCount"
      FROM baijiahao_automation_policies AS policy
      LEFT JOIN baijiahao_browser_sessions AS session
        ON session.tenant_id=policy.tenant_id AND session.account_id=policy.account_id
      LEFT JOIN LATERAL (
        SELECT batch.business_date,batch.status,batch.version,
          COALESCE(batch.last_error_json->>'message',batch.last_error_json->>'code')
            AS last_error_message,
          count(item.id)::integer AS attempted_count,
          count(item.id) FILTER (WHERE item.status IN (
            'pending','adapting','generating','quality_check','rewriting','qualified','processing'
          ))::integer AS in_progress_count,
          count(item.id) FILTER (WHERE item.status IN ('scheduled','processing','published'))::integer
            AS scheduled_count,
          count(item.id) FILTER (WHERE item.status='published')::integer AS published_count,
          count(item.id) FILTER (WHERE item.status='skipped')::integer AS skipped_count,
          count(item.id) FILTER (WHERE item.status='manual_required')::integer
            AS manual_required_count
        FROM baijiahao_daily_batches AS batch
        LEFT JOIN baijiahao_daily_batch_items AS item
          ON item.tenant_id=batch.tenant_id AND item.batch_id=batch.id
        WHERE batch.tenant_id=policy.tenant_id AND batch.policy_id=policy.id
          AND batch.business_date=(now() AT TIME ZONE policy.daily_timezone)::date
        GROUP BY batch.id ORDER BY batch.attempt_no DESC LIMIT 1
      ) AS today ON true
      WHERE policy.tenant_id=${scope.tenantId}::uuid AND policy.account_id=${accountId}::uuid
        AND (${projectId ?? null}::uuid IS NULL OR policy.project_id=${projectId ?? null}::uuid)
        AND has_project_scope_access(
          policy.tenant_id,policy.workspace_id,policy.project_id,${scope.userId}::uuid
        )
      ORDER BY policy.project_id
    `;
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
        version: number;
      }[]
    >`
      SELECT workspace_id AS "workspaceId",publish_mode AS "publishMode",status,version
      FROM platform_accounts
      WHERE id=${accountId}::uuid AND tenant_id=${scope.tenantId}::uuid
        AND platform_code='baijiahao' AND deleted_at IS NULL
        AND has_project_scope_access(tenant_id,workspace_id,NULL,${scope.userId}::uuid)
      ${lock ? client`FOR UPDATE` : client``}
    `;
    const account = rows[0];
    if (!account) throw notFound();
    return account;
  }
}

function mapPolicy(row: PolicyRow): BaijiahaoAutomationPolicyView {
  return {
    account_id: row.accountId,
    brand_consistency_min: row.brandConsistencyMin,
    browser_session:
      row.sessionAccountId && row.sessionStatus && row.sessionVersion
        ? {
            account_id: row.sessionAccountId,
            authenticated_at: dateTime(row.sessionAuthenticatedAt),
            last_verified_at: dateTime(row.sessionLastVerifiedAt),
            qr_expires_at: dateTime(row.sessionQrExpiresAt),
            status: row.sessionStatus,
            version: row.sessionVersion,
          }
        : null,
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
    independent_fallback_enabled: row.independentFallbackEnabled,
    max_rewrites: row.maxRewrites,
    max_source_similarity: frozenSourceSimilarity(row.maxSourceSimilarity),
    platform_fit_min: row.platformFitMin,
    project_id: row.projectId,
    publish_attempt_limit: row.publishAttemptLimit,
    question_coverage_min: row.questionCoverageMin,
    readability_safety_min: row.readabilitySafetyMin,
    source_mode: row.sourceMode,
    tenant_id: row.tenantId,
    today_batch:
      row.batchBusinessDate && row.batchStatus && row.batchVersion
        ? {
            attempted_count: row.attemptedCount ?? 0,
            business_date: dateOnly(row.batchBusinessDate),
            in_progress_count: row.inProgressCount ?? 0,
            last_error_message: row.batchLastErrorMessage,
            manual_required_count: row.manualRequiredCount ?? 0,
            published_count: row.publishedCount ?? 0,
            scheduled_count: row.scheduledCount ?? 0,
            skipped_count: row.skippedCount ?? 0,
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

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function frozenSourceSimilarity(value: number): 0.82 {
  if (value !== 0.82) {
    throw stateInvalid('Baijiahao source similarity threshold does not match the frozen contract');
  }
  return 0.82;
}

function dateTime(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function jsonbText(transaction: TransactionSql, value: unknown) {
  return transaction.typed(JSON.stringify(value), 25);
}

function notFound(): PlatformAccountError {
  return new PlatformAccountError(
    'PLATFORM_ACCOUNT_NOT_FOUND',
    'Baijiahao account or project was not found',
  );
}

function stateInvalid(message: string): PlatformAccountError {
  return new PlatformAccountError('PLATFORM_ACCOUNT_STATE_INVALID', message);
}

function versionConflict(): PlatformAccountError {
  return new PlatformAccountError(
    'PLATFORM_ACCOUNT_VERSION_CONFLICT',
    'Baijiahao automation policy version does not match',
  );
}
