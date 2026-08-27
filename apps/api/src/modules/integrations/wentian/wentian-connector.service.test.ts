import type { TransactionSql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import {
  WentianBindingConflictError,
  WentianConnectorNotConfiguredError,
  WentianConnectorService,
  WentianConnectorStateError,
} from './wentian-connector.service.js';
import type { WentianSignedClient } from './wentian-signed-client.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000101';
const USER_ID = '00000000-0000-4000-8000-000000000102';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000103';
const PROJECT_ID = '00000000-0000-4000-8000-000000000104';
const BINDING_ID = '00000000-0000-4000-8000-000000000105';
const REMOTE_BINDING_ID = '00000000-0000-4000-8000-000000000106';
const QUERY_SET_ID = '00000000-0000-4000-8000-000000000107';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000108';
const NOW = '2026-08-23T08:00:00.000Z';

describe('Wentian connector service boundaries', () => {
  it('rejects a binding endpoint that attempts to activate a project without Wentian approval', async () => {
    const transaction = transactionFor({
      'FROM projects AS project': [projectContext()],
      'FROM wentian_project_bindings': [],
    });
    const client = {
      requestBinding: vi.fn(async () => remoteBinding('active', SNAPSHOT_ID)),
    } as unknown as WentianSignedClient;
    const service = serviceWith(client);

    await expect(
      service.requestBinding(transaction, scope(), projectScope(), 'binding-test-1'),
    ).rejects.toBeInstanceOf(WentianConnectorStateError);
    expect(client.requestBinding).toHaveBeenCalledOnce();
  });

  it('rejects a query sync when Wentian reports a different query count', async () => {
    const transaction = transactionFor({
      'FROM projects AS project': [projectContext()],
      "AND status IN ('pending_wentian', 'active', 'suspended')": [bindingRow()],
      'FROM ai_visibility_query_sets': [
        {
          id: QUERY_SET_ID,
          locale: 'zh-CN',
          market: '广州',
          name: '广州搬家问题集',
          revision: 1,
          seriesId: QUERY_SET_ID,
        },
      ],
      'FROM ai_visibility_queries': [
        {
          commercialValue: 'high',
          intentCode: 'recommendation',
          queryKey: 'q001',
          queryText: '广州搬家公司哪家好？',
        },
      ],
    });
    const client = {
      syncQuerySet: vi.fn(async () => ({
        created: true,
        query_count: 2,
        snapshot_hash: 'a'.repeat(64),
        snapshot_id: SNAPSHOT_ID,
      })),
    } as unknown as WentianSignedClient;

    await expect(
      serviceWith(client).syncQuerySet(
        transaction,
        scope(),
        { ...projectScope(), querySetId: QUERY_SET_ID },
        'query-sync-test-1',
      ),
    ).rejects.toBeInstanceOf(WentianConnectorStateError);
  });

  it('rejects a same-version remote binding that changes state', async () => {
    const transaction = transactionFor({
      'FROM projects AS project': [projectContext()],
      'FROM wentian_project_bindings': [bindingRow()],
    });
    const client = {
      bindingStatus: vi.fn(async () => ({
        ...remoteBinding('active', SNAPSHOT_ID),
        status: 'suspended' as const,
      })),
    } as unknown as WentianSignedClient;

    await expect(
      serviceWith(client).refreshBinding(
        transaction,
        scope(),
        BINDING_ID,
        projectScope(),
        'binding-refresh-test-1',
      ),
    ).rejects.toBeInstanceOf(WentianBindingConflictError);
  });

  it('rejects an idempotent query revision that resolves to a different snapshot', async () => {
    const transaction = transactionFor({
      'FROM projects AS project': [projectContext()],
      "AND status IN ('pending_wentian', 'active', 'suspended')": [bindingRow()],
      'FROM ai_visibility_query_sets': [
        {
          id: QUERY_SET_ID,
          locale: 'zh-CN',
          market: '广州',
          name: '广州搬家问题集',
          revision: 1,
          seriesId: QUERY_SET_ID,
        },
      ],
      'FROM ai_visibility_queries': [
        {
          commercialValue: 'high',
          intentCode: 'recommendation',
          queryKey: 'q001',
          queryText: '广州搬家公司哪家好？',
        },
      ],
      'INSERT INTO wentian_query_set_syncs': [],
      'FROM wentian_query_set_syncs': [
        {
          id: SNAPSHOT_ID,
          queryCount: 1,
          querySetId: QUERY_SET_ID,
          querySetRevision: 1,
          snapshotHash: 'b'.repeat(64),
          syncedAt: NOW,
          wentianSnapshotId: '00000000-0000-4000-8000-000000000109',
        },
      ],
    });
    const client = {
      syncQuerySet: vi.fn(async () => ({
        created: false,
        query_count: 1,
        snapshot_hash: 'a'.repeat(64),
        snapshot_id: SNAPSHOT_ID,
      })),
    } as unknown as WentianSignedClient;

    await expect(
      serviceWith(client).syncQuerySet(
        transaction,
        scope(),
        { ...projectScope(), querySetId: QUERY_SET_ID },
        'query-sync-test-2',
      ),
    ).rejects.toBeInstanceOf(WentianConnectorStateError);
  });

  it('rejects configured connector use from a different GEO tenant before remote access', async () => {
    const client = { requestBinding: vi.fn() } as unknown as WentianSignedClient;
    const service = serviceWith(client);

    await expect(
      service.requestBinding(
        transactionFor({}),
        { ...scope(), tenantId: '00000000-0000-4000-8000-000000000199' },
        projectScope(),
        'binding-test-2',
      ),
    ).rejects.toBeInstanceOf(WentianConnectorNotConfiguredError);
    expect(client.requestBinding).not.toHaveBeenCalled();
  });

  it('rejects a disconnect response for a different GEO workspace', async () => {
    const transaction = transactionFor({
      'FROM wentian_project_bindings AS binding': [bindingRow()],
    });
    const client = {
      disconnectBinding: vi.fn(async () => ({
        ...remoteBinding('disconnected', SNAPSHOT_ID),
        geo_workspace_ref: '00000000-0000-4000-8000-000000000199',
        version: 3,
      })),
    } as unknown as WentianSignedClient;

    await expect(
      serviceWith(client).disconnectBinding(transaction, scope(), BINDING_ID, 'disconnect-test-1'),
    ).rejects.toBeInstanceOf(WentianBindingConflictError);
  });
});

function serviceWith(client: WentianSignedClient) {
  return new WentianConnectorService(
    (() => undefined) as never,
    {
      baseUrl: 'https://wentian.example.com',
      clientSecret: 's'.repeat(32),
      connectorId: REMOTE_BINDING_ID,
      contractVersion: 'wentian-geo-connector@1',
      geoTenantId: TENANT_ID,
      status: 'configured',
    },
    client,
    () => SNAPSHOT_ID,
    () => NOW,
  );
}

function transactionFor(results: Readonly<Record<string, readonly unknown[]>>): TransactionSql {
  return vi.fn(async (strings: TemplateStringsArray) => {
    const statement = strings.join('?');
    for (const [fragment, rows] of Object.entries(results)) {
      if (statement.includes(fragment)) return rows;
    }
    throw new Error(`Unexpected SQL in test: ${statement}`);
  }) as unknown as TransactionSql;
}

function scope() {
  return { requestId: 'request-1', tenantId: TENANT_ID, userId: USER_ID };
}

function projectScope() {
  return { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID };
}

function projectContext() {
  return { displayName: '测试成员', projectName: '广州搬家项目', roleCode: 'tenant_owner' };
}

function bindingRow() {
  return {
    decisionReason: null,
    geoProjectRef: PROJECT_ID,
    id: BINDING_ID,
    requestedAt: NOW,
    status: 'active',
    updatedAt: NOW,
    version: 2,
    wentianBindingId: REMOTE_BINDING_ID,
    wentianScopeId: SNAPSHOT_ID,
    workspaceId: WORKSPACE_ID,
  };
}

function remoteBinding(status: 'active' | 'disconnected', scopeId: string) {
  return {
    connector_instance_id: REMOTE_BINDING_ID,
    decision_reason: null,
    geo_project_display_name: '广州搬家项目',
    geo_project_ref: PROJECT_ID,
    geo_workspace_ref: WORKSPACE_ID,
    id: REMOTE_BINDING_ID,
    requested_at: NOW,
    scope_id: scopeId,
    status,
    updated_at: NOW,
    version: 2,
  };
}
