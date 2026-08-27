import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { WentianConnectorConfiguration } from './wentian-connector.config.js';
import {
  WentianConnectorNotConfiguredError,
  WentianConnectorResponseError,
  WentianSignedClient,
} from './wentian-signed-client.js';

const CONNECTOR_ID = '00000000-0000-4000-8000-000000000101';
const TENANT_ID = '00000000-0000-4000-8000-000000000102';
const BINDING_ID = '00000000-0000-4000-8000-000000000103';
const PROJECT_ID = '00000000-0000-4000-8000-000000000104';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000105';
const REQUEST_ID = '00000000-0000-4000-8000-000000000106';
const SECRET = 'signed-client-test-secret-00000001';
const NOW = '2026-08-23T08:00:00.000Z';

const CONFIGURATION: WentianConnectorConfiguration = {
  baseUrl: 'https://wentian.example.com',
  clientSecret: SECRET,
  connectorId: CONNECTOR_ID,
  contractVersion: 'wentian-geo-connector@1',
  geoTenantId: TENANT_ID,
  status: 'configured',
};

describe('Wentian signed client', () => {
  it('signs the exact raw request body and required replay-protection headers', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        'https://wentian.example.com/api/v1/integrations/geo/project-binding-requests',
      );
      const rawBody = String(init?.body);
      const headers = new Headers(init?.headers);
      const path = '/api/v1/integrations/geo/project-binding-requests';
      expect(init?.method).toBe('POST');
      expect(JSON.parse(rawBody)).toEqual({
        geo_project_display_name: '示例项目',
        geo_project_ref: PROJECT_ID,
        geo_workspace_ref: WORKSPACE_ID,
      });
      expect(headers.get('x-wentian-connector-id')).toBe(CONNECTOR_ID);
      expect(headers.get('x-wentian-contract-version')).toBe('wentian-geo-connector@1');
      expect(headers.get('x-wentian-issued-at')).toBe(NOW);
      expect(headers.get('x-wentian-request-id')).toBe(REQUEST_ID);
      expect(headers.get('idempotency-key')).toBe('bind-1');
      expect(headers.get('x-wentian-nonce')).toBeTruthy();
      expect(headers.get('x-wentian-signature')).toBe(
        signature({
          idempotencyKey: 'bind-1',
          issuedAt: NOW,
          method: 'POST',
          nonce: headers.get('x-wentian-nonce')!,
          path,
          rawBody,
          requestId: REQUEST_ID,
        }),
      );
      return new Response(JSON.stringify(binding()), { status: 201 });
    });

    const client = new WentianSignedClient(
      CONFIGURATION,
      fetchMock,
      () => NOW,
      () => REQUEST_ID,
    );
    await expect(
      client.requestBinding(
        {
          geoProjectDisplayName: '示例项目',
          geoProjectRef: PROJECT_ID,
          geoWorkspaceRef: WORKSPACE_ID,
        },
        'bind-1',
      ),
    ).resolves.toEqual(binding());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails closed when the connector is not configured', async () => {
    const client = new WentianSignedClient({
      contractVersion: 'wentian-geo-connector@1',
      status: 'not_configured',
    });
    await expect(client.bindingStatus(PROJECT_ID, 'status-1')).rejects.toBeInstanceOf(
      WentianConnectorNotConfiguredError,
    );
  });

  it('preserves only the bounded upstream error code', async () => {
    const client = new WentianSignedClient(
      CONFIGURATION,
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'GEO_BINDING_NOT_FOUND' }), { status: 404 }),
      ),
      () => NOW,
      () => REQUEST_ID,
    );
    await expect(client.bindingStatus(PROJECT_ID, 'status-2')).rejects.toMatchObject({
      code: 'GEO_BINDING_NOT_FOUND',
      status: 404,
    });
  });

  it('drops malformed upstream error text instead of preserving it as a loggable code', async () => {
    const client = new WentianSignedClient(
      CONFIGURATION,
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'GEO_ERROR\nsecret=response-body' }), {
            status: 502,
          }),
      ),
      () => NOW,
      () => REQUEST_ID,
    );
    await expect(client.bindingStatus(PROJECT_ID, 'status-malformed')).rejects.toMatchObject({
      code: null,
      status: 502,
    });
  });

  it('rejects an SSO launch URL outside the configured Wentian origin', async () => {
    const client = new WentianSignedClient(
      CONFIGURATION,
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              expires_at: '2026-08-23T08:01:00.000Z',
              launch_url: 'https://attacker.example/connect/geo?code=secret',
            }),
            { status: 201 },
          ),
      ),
      () => NOW,
      () => REQUEST_ID,
    );
    await expect(
      client.issueSsoTicket(
        {
          displayName: '成员',
          geoProjectRef: PROJECT_ID,
          geoUserRef: TENANT_ID,
          roleCodes: ['viewer'],
        },
        'sso-1',
      ),
    ).rejects.toBeInstanceOf(WentianConnectorResponseError);
  });

  it('rejects an SSO launch URL with credentials, fragments or duplicate codes', async () => {
    for (const launchUrl of [
      'https://user:pass@wentian.example.com/connect/geo?code=secret',
      'https://wentian.example.com/connect/geo?code=secret#fragment',
      'https://wentian.example.com/connect/geo?code=first&code=second',
    ]) {
      const client = new WentianSignedClient(
        CONFIGURATION,
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ expires_at: '2026-08-23T08:01:00.000Z', launch_url: launchUrl }),
              { status: 201 },
            ),
        ),
        () => NOW,
        () => REQUEST_ID,
      );
      await expect(
        client.issueSsoTicket(
          {
            displayName: '成员',
            geoProjectRef: PROJECT_ID,
            geoUserRef: TENANT_ID,
            roleCodes: ['viewer'],
          },
          'sso-invalid-url',
        ),
      ).rejects.toBeInstanceOf(WentianConnectorResponseError);
    }
  });

  it('rejects a binding owned by a different connector instance', async () => {
    const client = new WentianSignedClient(
      CONFIGURATION,
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...binding(),
              connector_instance_id: '00000000-0000-4000-8000-000000000199',
            }),
            { status: 200 },
          ),
      ),
      () => NOW,
      () => REQUEST_ID,
    );

    await expect(client.bindingStatus(PROJECT_ID, 'status-3')).rejects.toBeInstanceOf(
      WentianConnectorResponseError,
    );
  });
});

function binding() {
  return {
    connector_instance_id: CONNECTOR_ID,
    decision_reason: null,
    geo_project_display_name: '示例项目',
    geo_project_ref: PROJECT_ID,
    geo_workspace_ref: WORKSPACE_ID,
    id: BINDING_ID,
    requested_at: NOW,
    scope_id: null,
    status: 'pending_wentian' as const,
    updated_at: NOW,
    version: 1,
  };
}

function signature(input: {
  idempotencyKey: string;
  issuedAt: string;
  method: string;
  nonce: string;
  path: string;
  rawBody: string;
  requestId: string;
}): string {
  const bodyHash = createHash('sha256').update(input.rawBody, 'utf8').digest('hex');
  const canonical = [
    input.method,
    input.path,
    bodyHash,
    input.issuedAt,
    input.nonce,
    input.requestId,
    input.idempotencyKey,
    'wentian-geo-connector@1',
  ].join('\n');
  return createHmac('sha256', SECRET).update(canonical, 'utf8').digest('base64url');
}
