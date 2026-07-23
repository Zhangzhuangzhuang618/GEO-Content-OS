import { describe, expect, it, vi } from 'vitest';

import type { CredentialEnvelopeService } from '@geo-content-os/security/credentials';
import type { DatabaseClient } from '../../../database/index.js';
import { PlatformAccountService } from './platform-account.service.js';
import type { PlatformAccountConnector } from './platform-account.types.js';

describe('platform account serialization', () => {
  it('normalizes PostgreSQL timestamp strings returned by the database driver', async () => {
    const client = vi.fn(async () => [
      {
        capabilities_json: {},
        created_at: '2026-07-18 08:50:48+00',
        credential_ciphertext: null,
        credential_key_version: null,
        display_name: '官网账号',
        id: 'b1000000-0000-4000-8000-000000000001',
        platform_code: 'official_site',
        provider_account_id: null,
        publishing_url: null,
        publish_mode: 'manual',
        scopes: [],
        status: 'active',
        tenant_id: '20000000-0000-4000-8000-000000000001',
        timezone: 'Asia/Shanghai',
        token_expires_at: '2026-08-18 08:50:48+00',
        updated_at: '2026-07-18 08:51:00+00',
        version: 1,
        workspace_id: '22000000-0000-4000-8000-000000000002',
      },
    ]);
    const service = new PlatformAccountService(
      client as unknown as DatabaseClient,
      {} as CredentialEnvelopeService,
      {} as PlatformAccountConnector,
    );

    const result = await service.list({
      tenantId: '20000000-0000-4000-8000-000000000001',
      userId: '10000000-0000-4000-8000-000000000001',
    });

    expect(result[0]).toMatchObject({
      created_at: '2026-07-18T08:50:48.000Z',
      token_expires_at: '2026-08-18T08:50:48.000Z',
      updated_at: '2026-07-18T08:51:00.000Z',
    });
  });
});
