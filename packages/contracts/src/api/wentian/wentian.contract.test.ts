import { describe, expect, it } from 'vitest';

import {
  WENTIAN_API_CONTRACTS,
  WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION,
  WentianBindingViewSchema,
  WentianConnectorStatusViewSchema,
  WentianQuerySetSyncRequestSchema,
} from './index.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000101';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000102';

describe('Wentian connector contracts', () => {
  it('publishes the six versioned local connector operations', () => {
    expect(WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION).toBe('wentian-geo-connector@1');
    expect(
      WENTIAN_API_CONTRACTS.map(({ idempotency, key, method, path }) => ({
        idempotency,
        key,
        method,
        path,
      })),
    ).toEqual([
      {
        idempotency: '-',
        key: 'wentian.status',
        method: 'GET',
        path: '/integrations/wentian/status',
      },
      {
        idempotency: 'key+body_hash',
        key: 'wentian.binding.request',
        method: 'POST',
        path: '/integrations/wentian/bindings',
      },
      {
        idempotency: 'key+body_hash',
        key: 'wentian.binding.refresh',
        method: 'POST',
        path: '/integrations/wentian/bindings/{id}/refresh',
      },
      {
        idempotency: 'key+body_hash',
        key: 'wentian.binding.disconnect',
        method: 'DELETE',
        path: '/integrations/wentian/bindings/{id}',
      },
      {
        idempotency: 'key+body_hash',
        key: 'wentian.sso-ticket.create',
        method: 'POST',
        path: '/integrations/wentian/sso-tickets',
      },
      {
        idempotency: 'key+body_hash',
        key: 'wentian.query-set.sync',
        method: 'POST',
        path: '/integrations/wentian/query-set-syncs',
      },
    ]);
  });

  it('requires explicit project scope and query set selection', () => {
    expect(
      WentianQuerySetSyncRequestSchema.parse({
        project_id: PROJECT_ID,
        query_set_id: PROJECT_ID,
        workspace_id: WORKSPACE_ID,
      }),
    ).toEqual({
      project_id: PROJECT_ID,
      query_set_id: PROJECT_ID,
      workspace_id: WORKSPACE_ID,
    });
    expect(
      WentianQuerySetSyncRequestSchema.safeParse({
        project_id: PROJECT_ID,
        workspace_id: WORKSPACE_ID,
      }).success,
    ).toBe(false);
  });

  it('keeps local binding and sync views strict', () => {
    const binding = {
      decision_reason: null,
      geo_project_ref: PROJECT_ID,
      id: PROJECT_ID,
      requested_at: '2026-08-23T08:00:00.000Z',
      status: 'active',
      updated_at: '2026-08-23T08:01:00.000Z',
      version: 1,
      wentian_binding_id: WORKSPACE_ID,
      wentian_scope_id: PROJECT_ID,
    };
    expect(WentianBindingViewSchema.safeParse(binding).success).toBe(true);
    expect(WentianBindingViewSchema.safeParse({ ...binding, secret: 'forbidden' }).success).toBe(
      false,
    );
    expect(
      WentianConnectorStatusViewSchema.safeParse({
        binding,
        configuration_status: 'configured',
        contract_version: WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION,
        latest_sync: null,
      }).success,
    ).toBe(true);
  });
});
