import { describe, expect, it } from 'vitest';

import {
  CreatePlatformAccountRequestSchema,
  OfficialSiteDailyBatchCancelRequestSchema,
  OfficialSiteDailyBatchRestartRequestSchema,
  PUBLISHING_API_CONTRACTS,
  PUBLISHING_OPENAPI_DOCUMENT,
  PublishJobQuerySchema,
  ResolveUnknownPublishRequestSchema,
} from './index.js';

describe('Publishing API frozen contract', () => {
  it('contains all thirty-three publishing endpoints exactly once', () => {
    expect(PUBLISHING_API_CONTRACTS).toHaveLength(33);
    expect(
      new Set(PUBLISHING_API_CONTRACTS.map(({ method, path }) => `${method} ${path}`)).size,
    ).toBe(33);
    expect(
      PUBLISHING_API_CONTRACTS.every(({ permission }) => permission === 'publishing.manage'),
    ).toBe(true);
  });

  it('projects the aggregate into OpenAPI 3.1 with frozen guards', () => {
    expect(PUBLISHING_OPENAPI_DOCUMENT.openapi).toBe('3.1.0');
    const operations = Object.values(PUBLISHING_OPENAPI_DOCUMENT.paths).flatMap((path) =>
      Object.values(path),
    );
    expect(operations).toHaveLength(33);
    for (const contract of PUBLISHING_API_CONTRACTS) {
      const operation = PUBLISHING_OPENAPI_DOCUMENT.paths[contract.path]?.[
        contract.method.toLowerCase()
      ] as Record<string, unknown>;
      expect(operation['x-idempotency']).toBe(contract.idempotency);
      expect(operation['x-permission']).toBe(contract.permission);
      expect(operation['x-policy']).toBe(contract.policy);
    }
  });

  it('requires evidence before confirming an unknown publish as published', () => {
    expect(
      ResolveUnknownPublishRequestSchema.safeParse({ resolution: 'not_published' }).success,
    ).toBe(true);
    expect(
      ResolveUnknownPublishRequestSchema.safeParse({
        external_url: 'https://baijiahao.baidu.com/s?id=123',
        resolution: 'published',
      }).success,
    ).toBe(true);
    expect(ResolveUnknownPublishRequestSchema.safeParse({ resolution: 'published' }).success).toBe(
      false,
    );
    expect(
      ResolveUnknownPublishRequestSchema.safeParse({
        external_url: 'javascript:alert(1)',
        resolution: 'published',
      }).success,
    ).toBe(false);
  });

  it('requires an optimistic batch version when restarting today', () => {
    expect(
      OfficialSiteDailyBatchRestartRequestSchema.safeParse({
        expected_batch_version: 2,
        project_id: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      OfficialSiteDailyBatchRestartRequestSchema.safeParse({
        project_id: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('requires an optimistic batch version when cancelling today', () => {
    expect(
      OfficialSiteDailyBatchCancelRequestSchema.safeParse({
        expected_batch_version: 2,
        project_id: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      OfficialSiteDailyBatchCancelRequestSchema.safeParse({
        project_id: crypto.randomUUID(),
      }).success,
    ).toBe(false);
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

  it('lets the server inject Baijiahao browser gateway credentials', () => {
    expect(
      CreatePlatformAccountRequestSchema.safeParse({
        display_name: '百家号生产账号',
        platform_code: 'baijiahao',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      CreatePlatformAccountRequestSchema.safeParse({
        display_name: '官网生产账号',
        platform_code: 'official_site',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('requires a posting profile for Lieju browser publishing accounts', () => {
    const workspaceId = crypto.randomUUID();
    expect(
      CreatePlatformAccountRequestSchema.safeParse({
        display_name: '列举网生产账号',
        platform_code: 'lieju',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: workspaceId,
      }).success,
    ).toBe(false);
    expect(
      CreatePlatformAccountRequestSchema.safeParse({
        credential: {
          posting_profile: {
            address: '广州市天河区',
            category_id: '104',
            contact_name: '测试联系人',
            mobile_phone: '13800000000',
            zone_id: '5',
          },
        },
        display_name: '列举网生产账号',
        platform_code: 'lieju',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: workspaceId,
      }).success,
    ).toBe(true);
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
