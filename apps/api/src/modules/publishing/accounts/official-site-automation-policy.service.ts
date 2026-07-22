import type {
  OfficialSiteAutomationPolicyRequest,
  OfficialSiteAutomationPolicyView,
} from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import { resolveDatabaseClient, type DatabaseClientSource } from '../../../database/index.js';
import { PlatformAccountError } from './platform-account.errors.js';
import type { PlatformAccountAudit, PlatformAccountScope } from './platform-account.types.js';

interface PolicyRow {
  readonly accountId: string;
  readonly brandConsistencyMin: 90;
  readonly enabled: boolean;
  readonly factualAccuracyMin: 90;
  readonly geoTotalMin: 85;
  readonly id: string;
  readonly maxRewrites: 3;
  readonly platformFitMin: 80;
  readonly projectId: string;
  readonly publishAttemptLimit: 3;
  readonly questionCoverageMin: 80;
  readonly readabilitySafetyMin: 85;
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
        policy.geo_total_min AS "geoTotalMin",
        policy.factual_accuracy_min AS "factualAccuracyMin",
        policy.brand_consistency_min AS "brandConsistencyMin",
        policy.readability_safety_min AS "readabilitySafetyMin",
        policy.question_coverage_min AS "questionCoverageMin",
        policy.platform_fit_min AS "platformFitMin", policy.max_rewrites AS "maxRewrites",
        policy.publish_attempt_limit AS "publishAttemptLimit", policy.version,
        policy.updated_at AS "updatedAt"
      FROM official_site_automation_policies AS policy
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
      const existing = await transaction<PolicyRow[]>`
        SELECT
          id, tenant_id AS "tenantId", workspace_id AS "workspaceId",
          project_id AS "projectId", account_id AS "accountId", enabled,
          geo_total_min AS "geoTotalMin", factual_accuracy_min AS "factualAccuracyMin",
          brand_consistency_min AS "brandConsistencyMin",
          readability_safety_min AS "readabilitySafetyMin",
          question_coverage_min AS "questionCoverageMin", platform_fit_min AS "platformFitMin",
          max_rewrites AS "maxRewrites", publish_attempt_limit AS "publishAttemptLimit",
          version, updated_at AS "updatedAt"
        FROM official_site_automation_policies
        WHERE tenant_id=${scope.tenantId}::uuid AND project_id=${input.project_id}::uuid
        FOR UPDATE
      `;
      const before = existing[0];
      if (before && input.expected_version !== before.version) throw versionConflict();
      if (!before && input.expected_version !== undefined) throw versionConflict();
      const rows = await transaction<PolicyRow[]>`
        INSERT INTO official_site_automation_policies (
          tenant_id,workspace_id,project_id,account_id,enabled,created_by
        ) VALUES (
          ${scope.tenantId}::uuid,${account.workspaceId}::uuid,${input.project_id}::uuid,
          ${accountId}::uuid,${input.enabled},${scope.userId}::uuid
        )
        ON CONFLICT (tenant_id,project_id) DO UPDATE SET
          account_id=EXCLUDED.account_id, enabled=EXCLUDED.enabled, version=official_site_automation_policies.version+1
        RETURNING
          id,tenant_id AS "tenantId",workspace_id AS "workspaceId",project_id AS "projectId",
          account_id AS "accountId",enabled,geo_total_min AS "geoTotalMin",
          factual_accuracy_min AS "factualAccuracyMin",
          brand_consistency_min AS "brandConsistencyMin",
          readability_safety_min AS "readabilitySafetyMin",
          question_coverage_min AS "questionCoverageMin",platform_fit_min AS "platformFitMin",
          max_rewrites AS "maxRewrites",publish_attempt_limit AS "publishAttemptLimit",
          version,updated_at AS "updatedAt"
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
          ${after.id}::uuid,${before ? transaction.json(mapPolicy(before)) : null},
          ${transaction.json(mapPolicy(after))},${audit.ip ?? null},${audit.requestId}
        )
      `;
      return mapPolicy(after);
    });
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

function mapPolicy(row: PolicyRow): OfficialSiteAutomationPolicyView {
  return {
    account_id: row.accountId,
    brand_consistency_min: row.brandConsistencyMin,
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
    updated_at: new Date(row.updatedAt).toISOString(),
    version: row.version,
    workspace_id: row.workspaceId,
  };
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
