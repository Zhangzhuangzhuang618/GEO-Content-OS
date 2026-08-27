import type {
  WentianBindingView,
  WentianConnectorStatusView,
  WentianQuerySyncView,
} from '@geo-content-os/contracts';
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';
import type { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import type { WentianConnectorConfiguration } from './wentian-connector.config.js';
import { WentianRemoteRequestError } from './wentian-signed-client.js';
import type { WentianSignedClient, WentianRemoteBinding } from './wentian-signed-client.js';

export interface WentianConnectorScope {
  readonly requestId: string;
  readonly tenantId: string;
  readonly userId: string;
}

interface ProjectContext {
  readonly displayName: string;
  readonly projectName: string;
  readonly roleCode: string;
}

interface BindingRow {
  readonly decisionReason: string | null;
  readonly geoProjectRef: string;
  readonly id: string;
  readonly requestedAt: Date | string;
  readonly status: WentianBindingView['status'];
  readonly updatedAt: Date | string;
  readonly version: number;
  readonly wentianBindingId: string;
  readonly wentianScopeId: string | null;
  readonly workspaceId: string;
}

interface SyncRow {
  readonly id: string;
  readonly queryCount: number;
  readonly querySetId: string;
  readonly querySetRevision: number;
  readonly snapshotHash: string;
  readonly syncedAt: Date | string;
  readonly wentianSnapshotId: string;
}

interface QuerySetRow {
  readonly id: string;
  readonly locale: string;
  readonly market: string | null;
  readonly name: string;
  readonly revision: number;
  readonly seriesId: string;
}

interface QueryRow {
  readonly commercialValue: 'high' | 'low' | 'medium';
  readonly intentCode:
    | 'brand_recognition'
    | 'comparison'
    | 'education'
    | 'exploration'
    | 'procurement'
    | 'recommendation';
  readonly queryKey: string;
  readonly queryText: string;
}

export class WentianConnectorService {
  public constructor(
    private readonly database: DatabaseClient | IdentityAuthDatabase,
    private readonly configuration: WentianConnectorConfiguration,
    private readonly client: WentianSignedClient,
    private readonly newId: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async status(
    scope: WentianConnectorScope,
    input: { readonly projectId: string; readonly workspaceId: string },
  ): Promise<WentianConnectorStatusView> {
    return this.sql.begin(async (transaction) => {
      await requireProjectContext(transaction, scope, input, false);
      const binding = await selectLatestBinding(transaction, scope, input);
      const sync = await selectLatestSync(transaction, scope, input);
      return Object.freeze({
        binding: binding ? toBindingView(binding) : null,
        configuration_status: this.configurationStatus(scope.tenantId),
        contract_version: 'wentian-geo-connector@1',
        latest_sync: sync ? toSyncView(sync) : null,
      });
    });
  }

  public async requestBinding(
    transaction: TransactionSql,
    scope: WentianConnectorScope,
    input: { readonly projectId: string; readonly workspaceId: string },
    idempotencyKey: string,
  ): Promise<WentianBindingView> {
    this.requireConfiguredTenant(scope.tenantId);
    const project = await requireProjectContext(transaction, scope, input, true);
    const current = await selectOpenBinding(transaction, scope, input);
    if (current) throw new WentianBindingConflictError();
    const remote = await this.client.requestBinding(
      {
        geoProjectDisplayName: project.projectName,
        geoProjectRef: input.projectId,
        geoWorkspaceRef: input.workspaceId,
      },
      idempotencyKey,
    );
    if (
      remote.geo_project_ref !== input.projectId ||
      remote.geo_workspace_ref !== input.workspaceId ||
      remote.status !== 'pending_wentian' ||
      remote.scope_id !== null
    ) {
      throw new WentianConnectorStateError();
    }
    const localId = this.newId();
    let rows: BindingRow[];
    try {
      rows = await transaction<BindingRow[]>`
        INSERT INTO wentian_project_bindings (
          id, tenant_id, workspace_id, project_id, wentian_binding_id,
          wentian_scope_id, geo_project_ref, status, contract_version,
          decision_reason, requested_by, requested_at, updated_at, version
        ) VALUES (
          ${localId}::uuid, ${scope.tenantId}::uuid, ${input.workspaceId}::uuid,
          ${input.projectId}::uuid, ${remote.id}::uuid, ${remote.scope_id}::uuid,
          ${remote.geo_project_ref}, ${remote.status}, 'wentian-geo-connector@1',
          ${remote.decision_reason}, ${scope.userId}::uuid,
          ${remote.requested_at}::timestamptz, ${remote.updated_at}::timestamptz,
          ${remote.version}
        )
        RETURNING id, workspace_id AS "workspaceId",
          wentian_binding_id AS "wentianBindingId",
          wentian_scope_id AS "wentianScopeId", geo_project_ref AS "geoProjectRef",
          status, decision_reason AS "decisionReason", requested_at AS "requestedAt",
          updated_at AS "updatedAt", version
      `;
    } catch (error) {
      if (isUniqueViolation(error)) throw new WentianBindingConflictError();
      throw error;
    }
    const created = rows[0];
    if (!created) throw new WentianConnectorStateError();
    await audit(transaction, scope, 'wentian.binding.requested', localId, {
      project_id: input.projectId,
      status: created.status,
      wentian_binding_id: created.wentianBindingId,
      workspace_id: input.workspaceId,
    });
    return toBindingView(created);
  }

  public async refreshBinding(
    transaction: TransactionSql,
    scope: WentianConnectorScope,
    bindingId: string,
    input: { readonly projectId: string; readonly workspaceId: string },
    idempotencyKey: string,
  ): Promise<WentianBindingView> {
    this.requireConfiguredTenant(scope.tenantId);
    await requireProjectContext(transaction, scope, input, true);
    const binding = await selectBinding(transaction, scope, bindingId, input);
    const remote = await this.client.bindingStatus(binding.geoProjectRef, idempotencyKey);
    if (
      remote.id !== binding.wentianBindingId ||
      remote.geo_project_ref !== input.projectId ||
      remote.geo_workspace_ref !== input.workspaceId ||
      remote.version < binding.version ||
      (remote.version === binding.version && !sameBindingState(binding, remote))
    ) {
      throw new WentianBindingConflictError();
    }
    const updated = await updateBinding(transaction, scope, binding.id, remote);
    await audit(transaction, scope, 'wentian.binding.refreshed', binding.id, {
      project_id: input.projectId,
      status: updated.status,
      wentian_binding_id: updated.wentianBindingId,
    });
    return toBindingView(updated);
  }

  public async disconnectBinding(
    transaction: TransactionSql,
    scope: WentianConnectorScope,
    bindingId: string,
    idempotencyKey: string,
  ): Promise<WentianBindingView> {
    this.requireConfiguredTenant(scope.tenantId);
    const binding = await selectBindingForAdmin(transaction, scope, bindingId);
    const remote =
      binding.status === 'pending_wentian'
        ? await this.client.withdrawBinding(binding.wentianBindingId, idempotencyKey)
        : await this.client.disconnectBinding(binding.wentianBindingId, idempotencyKey);
    if (
      remote.id !== binding.wentianBindingId ||
      remote.geo_project_ref !== binding.geoProjectRef ||
      remote.geo_workspace_ref !== binding.workspaceId ||
      remote.status !== 'disconnected' ||
      remote.version <= binding.version
    ) {
      throw new WentianBindingConflictError();
    }
    const updated = await updateBinding(transaction, scope, binding.id, remote);
    await audit(transaction, scope, 'wentian.binding.disconnected', binding.id, {
      status: updated.status,
      wentian_binding_id: updated.wentianBindingId,
    });
    return toBindingView(updated);
  }

  public async issueSsoTicket(
    transaction: TransactionSql,
    scope: WentianConnectorScope,
    input: { readonly projectId: string; readonly workspaceId: string },
    idempotencyKey: string,
  ): Promise<{ readonly expires_at: string; readonly launch_url: string }> {
    this.requireConfiguredTenant(scope.tenantId);
    const project = await requireProjectContext(transaction, scope, input, false);
    if (!['tenant_owner', 'tenant_admin', 'analyst', 'viewer'].includes(project.roleCode)) {
      throw new WentianConnectorPermissionError();
    }
    const binding = await selectOpenBinding(transaction, scope, input);
    if (!binding || binding.status !== 'active') throw new WentianBindingNotFoundError();
    const ticket = await this.client.issueSsoTicket(
      {
        displayName: project.displayName,
        geoProjectRef: input.projectId,
        geoUserRef: scope.userId,
        roleCodes: [project.roleCode],
      },
      idempotencyKey,
    );
    await audit(transaction, scope, 'wentian.sso_ticket.issued', binding.id, {
      project_id: input.projectId,
      wentian_binding_id: binding.wentianBindingId,
    });
    return { expires_at: ticket.expires_at, launch_url: ticket.launch_url };
  }

  public async syncQuerySet(
    transaction: TransactionSql,
    scope: WentianConnectorScope,
    input: {
      readonly projectId: string;
      readonly querySetId: string;
      readonly workspaceId: string;
    },
    idempotencyKey: string,
  ): Promise<WentianQuerySyncView> {
    this.requireConfiguredTenant(scope.tenantId);
    await requireProjectContext(transaction, scope, input, true);
    const binding = await selectOpenBinding(transaction, scope, input);
    if (!binding || binding.status !== 'active') throw new WentianBindingNotFoundError();
    const querySet = await selectQuerySet(transaction, scope, input);
    const queries = await selectQueries(transaction, scope, querySet.id);
    validateQuerySet(querySet, queries);
    const remote = await this.client.syncQuerySet(
      binding.wentianBindingId,
      {
        geoQuerySetRef: querySet.seriesId,
        geoRevision: String(querySet.revision),
        locale: querySet.locale,
        market: querySet.market,
        queries: queries.map((query) => ({
          commercial_value: query.commercialValue,
          external_key: query.queryKey,
          intent: query.intentCode,
          text: query.queryText,
        })),
        title: querySet.name,
      },
      idempotencyKey,
    );
    if (remote.query_count !== queries.length) throw new WentianConnectorStateError();
    const syncId = this.newId();
    const syncedAt = new Date(this.now()).toISOString();
    await transaction`
      INSERT INTO wentian_query_set_syncs (
        id, tenant_id, workspace_id, project_id, binding_id, query_set_id,
        query_set_revision, wentian_snapshot_id, snapshot_hash, query_count,
        idempotency_key, synced_by, synced_at
      ) VALUES (
        ${syncId}::uuid, ${scope.tenantId}::uuid, ${input.workspaceId}::uuid,
        ${input.projectId}::uuid, ${binding.id}::uuid, ${querySet.id}::uuid,
        ${querySet.revision}, ${remote.snapshot_id}::uuid, ${remote.snapshot_hash},
        ${remote.query_count}, ${idempotencyKey}, ${scope.userId}::uuid,
        ${syncedAt}::timestamptz
      )
      ON CONFLICT (tenant_id, binding_id, query_set_id, query_set_revision)
      DO NOTHING
    `;
    const stored = await selectSync(transaction, scope, binding.id, querySet.id, querySet.revision);
    if (!stored) throw new WentianConnectorStateError();
    if (
      stored.wentianSnapshotId !== remote.snapshot_id ||
      stored.snapshotHash !== remote.snapshot_hash ||
      stored.queryCount !== remote.query_count
    ) {
      throw new WentianConnectorStateError();
    }
    await audit(transaction, scope, 'wentian.query_set.synced', stored.id, {
      project_id: input.projectId,
      query_set_id: querySet.id,
      query_set_revision: querySet.revision,
      wentian_snapshot_id: stored.wentianSnapshotId,
    });
    return toSyncView(stored);
  }

  private configurationStatus(
    tenantId: string,
  ): WentianConnectorStatusView['configuration_status'] {
    if (this.configuration.status !== 'configured') return this.configuration.status;
    return this.configuration.geoTenantId === tenantId ? 'configured' : 'not_configured';
  }

  private requireConfiguredTenant(tenantId: string): void {
    if (this.configuration.status !== 'configured' || this.configuration.geoTenantId !== tenantId) {
      throw new WentianConnectorNotConfiguredError();
    }
  }

  private get sql(): DatabaseClient {
    return typeof this.database === 'function' ? this.database : this.database.client;
  }
}

export class WentianConnectorNotConfiguredError extends Error {}
export class WentianConnectorPermissionError extends Error {}
export class WentianConnectorStateError extends Error {}
export class WentianBindingConflictError extends Error {}
export class WentianBindingNotFoundError extends Error {}
export class WentianQuerySetValidationError extends Error {}

async function requireProjectContext(
  transaction: TransactionSql,
  scope: WentianConnectorScope,
  input: { readonly projectId: string; readonly workspaceId: string },
  requireAdmin: boolean,
): Promise<ProjectContext> {
  const rows = await transaction<ProjectContext[]>`
    SELECT identity_user.display_name AS "displayName", project.name AS "projectName",
           membership.role_code AS "roleCode"
    FROM projects AS project
    JOIN workspaces AS workspace
      ON workspace.id = project.workspace_id AND workspace.tenant_id = project.tenant_id
    JOIN memberships AS membership ON membership.tenant_id = project.tenant_id
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    WHERE project.id = ${input.projectId}::uuid
      AND project.tenant_id = ${scope.tenantId}::uuid
      AND project.workspace_id = ${input.workspaceId}::uuid
      AND project.status = 'active' AND project.deleted_at IS NULL
      AND workspace.status = 'active' AND workspace.deleted_at IS NULL
      AND membership.user_id = ${scope.userId}::uuid
      AND membership.status = 'active'
      AND identity_user.status = 'active' AND identity_user.deleted_at IS NULL
      AND has_project_scope_access(
        project.tenant_id, project.workspace_id, project.id, membership.user_id
      )
  `;
  const row = rows[0];
  if (!row) throw new WentianBindingNotFoundError();
  if (requireAdmin && !['tenant_owner', 'tenant_admin'].includes(row.roleCode)) {
    throw new WentianConnectorPermissionError();
  }
  return row;
}

async function selectLatestBinding(
  transaction: TransactionSql,
  scope: WentianConnectorScope,
  input: { readonly projectId: string; readonly workspaceId: string },
): Promise<BindingRow | undefined> {
  const rows = await transaction<BindingRow[]>`
    SELECT id, workspace_id AS "workspaceId", wentian_binding_id AS "wentianBindingId",
           wentian_scope_id AS "wentianScopeId", geo_project_ref AS "geoProjectRef",
           status, decision_reason AS "decisionReason", requested_at AS "requestedAt",
           updated_at AS "updatedAt", version
    FROM wentian_project_bindings
    WHERE tenant_id = ${scope.tenantId}::uuid
      AND workspace_id = ${input.workspaceId}::uuid
      AND project_id = ${input.projectId}::uuid
    ORDER BY requested_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0];
}

async function selectOpenBinding(
  transaction: TransactionSql,
  scope: WentianConnectorScope,
  input: { readonly projectId: string; readonly workspaceId: string },
): Promise<BindingRow | undefined> {
  const rows = await transaction<BindingRow[]>`
    SELECT id, workspace_id AS "workspaceId", wentian_binding_id AS "wentianBindingId",
           wentian_scope_id AS "wentianScopeId", geo_project_ref AS "geoProjectRef",
           status, decision_reason AS "decisionReason", requested_at AS "requestedAt",
           updated_at AS "updatedAt", version
    FROM wentian_project_bindings
    WHERE tenant_id = ${scope.tenantId}::uuid
      AND workspace_id = ${input.workspaceId}::uuid
      AND project_id = ${input.projectId}::uuid
      AND status IN ('pending_wentian', 'active', 'suspended')
    LIMIT 1
  `;
  return rows[0];
}

async function selectBinding(
  transaction: TransactionSql,
  scope: WentianConnectorScope,
  bindingId: string,
  input: { readonly projectId: string; readonly workspaceId: string },
): Promise<BindingRow> {
  const rows = await transaction<BindingRow[]>`
    SELECT id, workspace_id AS "workspaceId", wentian_binding_id AS "wentianBindingId",
           wentian_scope_id AS "wentianScopeId", geo_project_ref AS "geoProjectRef",
           status, decision_reason AS "decisionReason", requested_at AS "requestedAt",
           updated_at AS "updatedAt", version
    FROM wentian_project_bindings
    WHERE id = ${bindingId}::uuid
      AND tenant_id = ${scope.tenantId}::uuid
      AND workspace_id = ${input.workspaceId}::uuid
      AND project_id = ${input.projectId}::uuid
  `;
  if (!rows[0]) throw new WentianBindingNotFoundError();
  return rows[0];
}

async function selectBindingForAdmin(
  transaction: TransactionSql,
  scope: WentianConnectorScope,
  bindingId: string,
): Promise<BindingRow> {
  const rows = await transaction<BindingRow[]>`
    SELECT binding.id, binding.workspace_id AS "workspaceId",
           binding.wentian_binding_id AS "wentianBindingId",
           binding.wentian_scope_id AS "wentianScopeId",
           binding.geo_project_ref AS "geoProjectRef", binding.status,
           binding.decision_reason AS "decisionReason",
           binding.requested_at AS "requestedAt", binding.updated_at AS "updatedAt",
           binding.version
    FROM wentian_project_bindings AS binding
    JOIN memberships AS membership ON membership.tenant_id = binding.tenant_id
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    WHERE binding.id = ${bindingId}::uuid
      AND binding.tenant_id = ${scope.tenantId}::uuid
      AND membership.user_id = ${scope.userId}::uuid
      AND membership.status = 'active'
      AND membership.role_code IN ('tenant_owner', 'tenant_admin')
      AND identity_user.status = 'active' AND identity_user.deleted_at IS NULL
      AND has_project_scope_access(
        binding.tenant_id, binding.workspace_id, binding.project_id, membership.user_id
      )
  `;
  if (!rows[0]) throw new WentianBindingNotFoundError();
  if (['rejected', 'disconnected'].includes(rows[0].status)) {
    throw new WentianConnectorStateError();
  }
  return rows[0];
}

async function updateBinding(
  transaction: TransactionSql,
  scope: WentianConnectorScope,
  localBindingId: string,
  remote: WentianRemoteBinding,
): Promise<BindingRow> {
  const rows = await transaction<BindingRow[]>`
    UPDATE wentian_project_bindings
    SET wentian_scope_id = ${remote.scope_id}::uuid,
        status = ${remote.status}, decision_reason = ${remote.decision_reason},
        updated_at = ${remote.updated_at}::timestamptz, version = ${remote.version}
    WHERE id = ${localBindingId}::uuid
      AND tenant_id = ${scope.tenantId}::uuid
      AND wentian_binding_id = ${remote.id}::uuid
      AND version <= ${remote.version}
    RETURNING id, workspace_id AS "workspaceId",
      wentian_binding_id AS "wentianBindingId",
      wentian_scope_id AS "wentianScopeId", geo_project_ref AS "geoProjectRef",
      status, decision_reason AS "decisionReason", requested_at AS "requestedAt",
      updated_at AS "updatedAt", version
  `;
  if (!rows[0]) throw new WentianBindingNotFoundError();
  return rows[0];
}

async function selectLatestSync(
  transaction: TransactionSql,
  scope: WentianConnectorScope,
  input: { readonly projectId: string; readonly workspaceId: string },
): Promise<SyncRow | undefined> {
  const rows = await transaction<SyncRow[]>`
    SELECT id, query_set_id AS "querySetId", query_set_revision AS "querySetRevision",
           wentian_snapshot_id AS "wentianSnapshotId", snapshot_hash AS "snapshotHash",
           query_count AS "queryCount", synced_at AS "syncedAt"
    FROM wentian_query_set_syncs
    WHERE tenant_id = ${scope.tenantId}::uuid
      AND workspace_id = ${input.workspaceId}::uuid
      AND project_id = ${input.projectId}::uuid
    ORDER BY synced_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0];
}

async function selectQuerySet(
  transaction: TransactionSql,
  scope: WentianConnectorScope,
  input: { readonly projectId: string; readonly querySetId: string; readonly workspaceId: string },
): Promise<QuerySetRow> {
  const rows = await transaction<QuerySetRow[]>`
    SELECT id, series_id AS "seriesId", revision, name, locale, market
    FROM ai_visibility_query_sets
    WHERE id = ${input.querySetId}::uuid
      AND tenant_id = ${scope.tenantId}::uuid
      AND workspace_id = ${input.workspaceId}::uuid
      AND project_id = ${input.projectId}::uuid
      AND status = 'active'
  `;
  if (!rows[0]) throw new WentianBindingNotFoundError();
  return rows[0];
}

async function selectQueries(
  transaction: TransactionSql,
  scope: WentianConnectorScope,
  querySetId: string,
): Promise<readonly QueryRow[]> {
  return transaction<QueryRow[]>`
    SELECT query_key AS "queryKey", query_text AS "queryText",
           intent_code AS "intentCode", commercial_value AS "commercialValue"
    FROM ai_visibility_queries
    WHERE tenant_id = ${scope.tenantId}::uuid AND query_set_id = ${querySetId}::uuid
    ORDER BY sort_order, id
  `;
}

async function selectSync(
  transaction: TransactionSql,
  scope: WentianConnectorScope,
  bindingId: string,
  querySetId: string,
  revision: number,
): Promise<SyncRow | undefined> {
  const rows = await transaction<SyncRow[]>`
    SELECT id, query_set_id AS "querySetId", query_set_revision AS "querySetRevision",
           wentian_snapshot_id AS "wentianSnapshotId", snapshot_hash AS "snapshotHash",
           query_count AS "queryCount", synced_at AS "syncedAt"
    FROM wentian_query_set_syncs
    WHERE tenant_id = ${scope.tenantId}::uuid
      AND binding_id = ${bindingId}::uuid
      AND query_set_id = ${querySetId}::uuid
      AND query_set_revision = ${revision}
  `;
  return rows[0];
}

function validateQuerySet(querySet: QuerySetRow, queries: readonly QueryRow[]): void {
  if (
    querySet.name.length > 120 ||
    querySet.locale.length > 16 ||
    (querySet.market?.length ?? 0) > 120 ||
    queries.length < 1 ||
    queries.length > 100 ||
    queries.some((query) => query.queryText.trim().length > 1_000)
  ) {
    throw new WentianQuerySetValidationError();
  }
}

function sameBindingState(binding: BindingRow, remote: WentianRemoteBinding): boolean {
  return (
    binding.status === remote.status &&
    binding.wentianScopeId === remote.scope_id &&
    binding.decisionReason === remote.decision_reason
  );
}

function toBindingView(row: BindingRow): WentianBindingView {
  return Object.freeze({
    decision_reason: row.decisionReason,
    geo_project_ref: row.geoProjectRef,
    id: row.id,
    requested_at: toIso(row.requestedAt),
    status: row.status,
    updated_at: toIso(row.updatedAt),
    version: row.version,
    wentian_binding_id: row.wentianBindingId,
    wentian_scope_id: row.wentianScopeId,
  });
}

function toSyncView(row: SyncRow): WentianQuerySyncView {
  return Object.freeze({
    id: row.id,
    query_count: row.queryCount,
    query_set_id: row.querySetId,
    query_set_revision: row.querySetRevision,
    snapshot_hash: row.snapshotHash,
    synced_at: toIso(row.syncedAt),
    wentian_snapshot_id: row.wentianSnapshotId,
  });
}

async function audit(
  transaction: TransactionSql,
  scope: WentianConnectorScope,
  action: string,
  resourceId: string,
  after: Readonly<Record<string, unknown>>,
): Promise<void> {
  await transaction`
    INSERT INTO audit_events (
      tenant_id, actor_id, action, resource_type, resource_id, after_json, request_id
    ) VALUES (
      ${scope.tenantId}::uuid, ${scope.userId}::uuid, ${action},
      'wentian_connector', ${resourceId}::uuid,
      ${JSON.stringify(after)}::text::jsonb, ${scope.requestId}
    )
  `;
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export function isWentianRemoteConflict(error: unknown): boolean {
  return (
    error instanceof WentianRemoteRequestError &&
    ['GEO_BINDING_CONFLICT', 'GEO_IDEMPOTENCY_CONFLICT'].includes(error.code ?? '')
  );
}
