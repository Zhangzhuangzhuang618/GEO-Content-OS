import { hashBaijiahaoPayload } from '@geo-content-os/adapter-platforms/baijiahao/delivery';
import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import type { CredentialEnvelopeService } from '@geo-content-os/security/credentials';
import { describe, expect, it, vi } from 'vitest';

import type { BaijiahaoBrowserConfig } from './config.js';
import { PageDriverError } from './page-driver.js';
import { BaijiahaoBrowserService } from './service.js';
import type { PostgresBaijiahaoBrowserStore } from './store.js';
import type { BaijiahaoPageDriver, BrowserSession, PublicationClaim } from './types.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000145';
const CONTENT_VERSION_ID = '00000000-0000-4000-8000-000000000146';
const PUBLICATION_ID = '00000000-0000-4000-8000-000000000147';
const SESSION_ID = '00000000-0000-4000-8000-000000000148';
const TENANT_ID = '00000000-0000-4000-8000-000000000149';

describe('Baijiahao browser service', () => {
  it('persists a safe attention state when the login page signature changes', async () => {
    const session = browserSession('login_required');
    const markSession = vi.fn(async () => ({
      ...session,
      status: 'attention_required',
      version: 2,
    }));
    const store = {
      getOrCreateSession: vi.fn(async () => session),
      markSession,
    } as unknown as PostgresBaijiahaoBrowserStore;
    const driver = {
      startLogin: vi.fn(async () => {
        throw new PageDriverError(
          'PAGE_SIGNATURE_CHANGED',
          'Baijiahao login entry no longer matches the frozen page signature',
        );
      }),
    } as unknown as BaijiahaoPageDriver;
    const service = new BaijiahaoBrowserService(
      config(),
      store,
      driver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.startLogin(ACCOUNT_ID)).rejects.toMatchObject({
      code: 'PAGE_SIGNATURE_CHANGED',
      statusCode: 423,
    });
    expect(markSession).toHaveBeenCalledWith(session, {
      error: {
        code: 'PAGE_SIGNATURE_CHANGED',
        schema_version: 'baijiahao-browser-error@1',
      },
      qrExpiresAt: null,
      status: 'attention_required',
    });
  });

  it('reports an immediate platform rejection instead of claiming the publication is processing', async () => {
    const session = browserSession('authenticated');
    const prepared: PublicationClaim = Object.freeze({
      accountId: ACCOUNT_ID,
      contentVersionId: CONTENT_VERSION_ID,
      id: PUBLICATION_ID,
      idempotencyKey: 'baijiahao-t145-rejected',
      publishJobId: '00000000-0000-4000-8000-000000000150',
      sessionId: SESSION_ID,
      status: 'prepared',
      tenantId: TENANT_ID,
      version: 1,
    });
    const updatePublication = vi.fn(
      async (publication: PublicationClaim, update: Readonly<Record<string, unknown>>) =>
        Object.freeze({
          ...publication,
          ...(update['remote'] && typeof update['remote'] === 'object'
            ? {
                externalId: 'rejected-145',
                externalUrl: null,
              }
            : {}),
          status: update['status'] as PublicationClaim['status'],
          version: publication.version + 1,
        }),
    );
    const store = {
      getOrCreateSession: vi.fn(async () => session),
      insertArtifact: vi.fn(async () => undefined),
      loadImageAssets: vi.fn(async () => []),
      preparePublication: vi.fn(async () => prepared),
      updatePublication,
    } as unknown as PostgresBaijiahaoBrowserStore;
    const driver = {
      capture: vi.fn(async () => Buffer.from('post-submit')),
      submit: vi.fn(async () => ({
        externalId: 'rejected-145',
        reviewReason: '内容未通过审核',
        status: 'failed' as const,
        url: null,
      })),
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as BaijiahaoPageDriver;
    const credentials = {
      decrypt: vi.fn(async () => '{}'),
    } as unknown as CredentialEnvelopeService;
    const storage = {
      putObject: vi.fn(async () => ({ uri: 'memory://test/post-submit.png' })),
    } as unknown as ObjectStorageAdapter;
    const service = new BaijiahaoBrowserService(config(), store, driver, credentials, storage);
    const payload = {
      abstract: '用于验证百家号驳回处理的摘要。',
      body_asset_ids: [],
      body_html: '<p>用于验证百家号驳回处理的正文。</p>',
      body_text: '用于验证百家号驳回处理的正文。',
      citation_links: [],
      content_type: 'news',
      cover_asset_id: null,
      platform_code: 'baijiahao' as const,
      rule_version: 'baijiahao-render-rules@1.1.0' as const,
      schema_version: 'baijiahao-payload@2' as const,
      tags: ['百家号', '审核', '验证'],
      title: '百家号驳回状态验证',
    };

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: prepared.idempotencyKey,
        payload,
        payload_hash: hashBaijiahaoPayload(payload),
      }),
    ).rejects.toMatchObject({ code: 'PUBLISH_REJECTED', statusCode: 409 });
    expect(updatePublication).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'submitting' }),
      expect.objectContaining({ status: 'failed' }),
    );
  });
});

function browserSession(status: BrowserSession['status']): BrowserSession {
  return Object.freeze({
    accountId: ACCOUNT_ID,
    authenticatedAt: status === 'authenticated' ? new Date('2026-08-02T00:00:00.000Z') : null,
    id: SESSION_ID,
    lastVerifiedAt: status === 'authenticated' ? new Date('2026-08-02T00:00:00.000Z') : null,
    profileKey: `baijiahao/${TENANT_ID}/${ACCOUNT_ID}`,
    qrExpiresAt: null,
    status,
    storageStateCiphertext: status === 'authenticated' ? 'encrypted-state' : null,
    storageStateKeyVersion: status === 'authenticated' ? 'test-v1' : null,
    tenantId: TENANT_ID,
    version: 1,
  });
}

function config(): BaijiahaoBrowserConfig {
  return Object.freeze({
    databaseUrl: 'postgresql://unused',
    editorUrl: 'https://baijiahao.example/editor',
    gatewayToken: 'x'.repeat(32),
    headless: true,
    healthPort: 9095,
    loginUrl: 'https://baijiahao.example/login',
    manageUrl: 'https://baijiahao.example/manage',
    navigationTimeoutMs: 5_000,
    profileRoot: '/tmp/geo-baijiahao-service-test',
    simulator: true,
  });
}
