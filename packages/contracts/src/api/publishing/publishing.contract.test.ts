import { describe, expect, it } from 'vitest';

import {
  CreatePlatformAccountRequestSchema,
  PUBLISHING_API_CONTRACTS,
  PUBLISHING_OPENAPI_DOCUMENT,
  PublishJobQuerySchema,
} from './index.js';

describe('Publishing API frozen contract', () => {
  it('contains all seventeen publishing endpoints exactly once', () => {
    expect(PUBLISHING_API_CONTRACTS).toHaveLength(17);
    expect(
      new Set(PUBLISHING_API_CONTRACTS.map(({ method, path }) => `${method} ${path}`)).size,
    ).toBe(17);
    expect(
      PUBLISHING_API_CONTRACTS.every(({ permission }) => permission === 'publishing.manage'),
    ).toBe(true);
  });

  it('projects the aggregate into OpenAPI 3.1 with frozen guards', () => {
    expect(PUBLISHING_OPENAPI_DOCUMENT.openapi).toBe('3.1.0');
    const operations = Object.values(PUBLISHING_OPENAPI_DOCUMENT.paths).flatMap((path) =>
      Object.values(path),
    );
    expect(operations).toHaveLength(17);
    for (const contract of PUBLISHING_API_CONTRACTS) {
      const operation = PUBLISHING_OPENAPI_DOCUMENT.paths[contract.path]?.[
        contract.method.toLowerCase()
      ] as Record<string, unknown>;
      expect(operation['x-idempotency']).toBe(contract.idempotency);
      expect(operation['x-permission']).toBe(contract.permission);
      expect(operation['x-policy']).toBe(contract.policy);
    }
  });

  it('keeps tenant context and credentials out of queries and responses', () => {
    expect(PublishJobQuerySchema.safeParse({ tenant_id: crypto.randomUUID() }).success).toBe(false);
    expect(
      CreatePlatformAccountRequestSchema.safeParse({
        display_name: 'Export account',
        platform_code: 'official_site',
        publish_mode: 'export',
        tenant_id: crypto.randomUUID(),
        timezone: 'Asia/Shanghai',
        workspace_id: crypto.randomUUID(),
      }).success,
    ).toBe(false);
    expect(JSON.stringify(PUBLISHING_OPENAPI_DOCUMENT)).not.toContain('credential_ciphertext');
  });

  it('orders calendar bounds by instant instead of timezone text', () => {
    expect(
      PublishJobQuerySchema.safeParse({
        from: '2026-07-16T08:00:00+08:00',
        to: '2026-07-16T01:00:00Z',
      }).success,
    ).toBe(true);
  });
});
