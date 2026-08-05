import { hashBaijiahaoPayload } from '@geo-content-os/adapter-platforms/baijiahao/delivery';
import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import {
  CredentialEnvelopeError,
  type CredentialEnvelopeService,
} from '@geo-content-os/security/credentials';
import { describe, expect, it, vi } from 'vitest';

import type { BaijiahaoBrowserConfig } from './config.js';
import { PageDriverError, PageDriverOperationError } from './page-driver.js';
import { BaijiahaoBrowserService, BrowserGatewayError, safeBrowserError } from './service.js';
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

  it('contains asynchronous login verification failures without crashing the worker', async () => {
    const session = browserSession('login_required');
    const expiresAt = new Date('2026-08-05T14:00:00.000Z');
    const pending = {
      ...session,
      qrExpiresAt: expiresAt,
      status: 'qr_ready' as const,
      version: 2,
    };
    const attention = {
      ...pending,
      qrExpiresAt: null,
      status: 'attention_required' as const,
      version: 3,
    };
    const markSession = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(attention);
    const store = {
      getOrCreateSession: vi.fn(async () => session),
      getSession: vi.fn(async () => pending),
      markSession,
    } as unknown as PostgresBaijiahaoBrowserStore;
    const driver = {
      startLogin: vi.fn(async () => ({ expiresAt, qrPng: Buffer.from('qr') })),
      waitForAuthentication: vi.fn(async () => {
        throw new Error('page.goto: net::ERR_ABORTED token=login-secret');
      }),
    } as unknown as BaijiahaoPageDriver;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new BaijiahaoBrowserService(
      config(),
      store,
      driver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.startLogin(ACCOUNT_ID)).resolves.toMatchObject({ status: 'qr_ready' });
    await vi.waitFor(() =>
      expect(markSession).toHaveBeenLastCalledWith(pending, {
        error: {
          code: 'LOGIN_VERIFICATION_FAILED',
          schema_version: 'baijiahao-browser-error@1',
        },
        qrExpiresAt: null,
        status: 'attention_required',
      }),
    );
    expect(errorLog).toHaveBeenCalledWith(
      'Baijiahao browser login verification failed',
      expect.objectContaining({
        error: 'Error: page.goto: net::ERR_ABORTED token=[REDACTED]',
        error_code: 'LOGIN_VERIFICATION_FAILED',
      }),
    );
    errorLog.mockRestore();
  });

  it('marks an encrypted session for reauthentication when decryption fails', async () => {
    const session = browserSession('authenticated');
    const reauth = { ...session, status: 'reauth' as const, version: 2 };
    const markSession = vi.fn(async () => reauth);
    const markAccountReauth = vi.fn(async () => undefined);
    const store = {
      getSession: vi.fn(async () => session),
      markAccountReauth,
      markSession,
    } as unknown as PostgresBaijiahaoBrowserStore;
    const credentials = {
      decrypt: vi.fn(async () => {
        throw new CredentialEnvelopeError('CREDENTIAL_DECRYPTION_FAILED');
      }),
    } as unknown as CredentialEnvelopeService;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new BaijiahaoBrowserService(
      config(),
      store,
      {} as BaijiahaoPageDriver,
      credentials,
      {} as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      status: 'reauth',
      version: 2,
    });
    expect(markAccountReauth).toHaveBeenCalledWith(ACCOUNT_ID, TENANT_ID);
    expect(markSession).toHaveBeenCalledWith(session, {
      error: {
        code: 'CREDENTIAL_DECRYPTION_FAILED',
        schema_version: 'baijiahao-browser-error@1',
      },
      status: 'reauth',
    });
    expect(errorLog).toHaveBeenCalledWith(
      'Baijiahao browser session verification failed',
      expect.objectContaining({ error_code: 'CREDENTIAL_DECRYPTION_FAILED' }),
    );
    errorLog.mockRestore();
  });

  it('persists an attention state for an unexpected browser runtime failure', async () => {
    const session = browserSession('authenticated');
    const attention = { ...session, status: 'attention_required' as const, version: 2 };
    const markSession = vi.fn(async () => attention);
    const store = {
      getSession: vi.fn(async () => session),
      markSession,
    } as unknown as PostgresBaijiahaoBrowserStore;
    const driver = {
      verifyAuthenticated: vi.fn(async () => {
        throw new Error('Chromium failed token=browser-secret');
      }),
    } as unknown as BaijiahaoPageDriver;
    const credentials = {
      decrypt: vi.fn(async () => '{}'),
    } as unknown as CredentialEnvelopeService;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new BaijiahaoBrowserService(
      config(),
      store,
      driver,
      credentials,
      {} as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      status: 'attention_required',
      version: 2,
    });
    expect(markSession).toHaveBeenCalledWith(session, {
      error: { code: 'BROWSER_RUNTIME_FAILED', schema_version: 'baijiahao-browser-error@1' },
      status: 'attention_required',
    });
    expect(errorLog).toHaveBeenCalledWith(
      'Baijiahao browser session verification failed',
      expect.objectContaining({
        error: 'Error: Chromium failed token=[REDACTED]',
        error_code: 'BROWSER_RUNTIME_FAILED',
      }),
    );
    errorLog.mockRestore();
  });

  it('classifies a captcha encountered during real-time verification', async () => {
    const session = browserSession('authenticated');
    const attention = { ...session, status: 'attention_required' as const, version: 2 };
    const markSession = vi.fn(async () => attention);
    const store = {
      getSession: vi.fn(async () => session),
      markSession,
    } as unknown as PostgresBaijiahaoBrowserStore;
    const driver = {
      verifyAuthenticated: vi.fn(async () => {
        throw new PageDriverError('CAPTCHA_REQUIRED', 'Baijiahao requested human verification');
      }),
    } as unknown as BaijiahaoPageDriver;
    const credentials = {
      decrypt: vi.fn(async () => '{}'),
    } as unknown as CredentialEnvelopeService;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new BaijiahaoBrowserService(
      config(),
      store,
      driver,
      credentials,
      {} as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      status: 'attention_required',
    });
    expect(markSession).toHaveBeenCalledWith(session, {
      error: { code: 'CAPTCHA_REQUIRED', schema_version: 'baijiahao-browser-error@1' },
      status: 'attention_required',
    });
    errorLog.mockRestore();
  });

  it('does not re-run browser verification after a concurrent poll changes the session state', async () => {
    const authenticated = browserSession('authenticated');
    const attention = { ...authenticated, status: 'attention_required' as const, version: 2 };
    const verifyAuthenticated = vi.fn(async () => true);
    const store = {
      getSession: vi.fn().mockResolvedValueOnce(authenticated).mockResolvedValueOnce(attention),
    } as unknown as PostgresBaijiahaoBrowserStore;
    const service = new BaijiahaoBrowserService(
      config(),
      store,
      { verifyAuthenticated } as unknown as BaijiahaoPageDriver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      status: 'attention_required',
      version: 2,
    });
    expect(verifyAuthenticated).not.toHaveBeenCalled();
  });

  it('re-verifies an attention session and clears the browser safety pause', async () => {
    const attention = browserSession('attention_required');
    const authenticated = {
      ...attention,
      lastVerifiedAt: new Date('2026-08-05T00:00:00.000Z'),
      status: 'authenticated' as const,
      version: 2,
    };
    const markSession = vi.fn(async () => authenticated);
    const store = {
      getSession: vi.fn(async () => attention),
      markSession,
    } as unknown as PostgresBaijiahaoBrowserStore;
    const driver = {
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as BaijiahaoPageDriver;
    const credentials = {
      decrypt: vi.fn(async () => '{}'),
    } as unknown as CredentialEnvelopeService;
    const service = new BaijiahaoBrowserService(
      config(),
      store,
      driver,
      credentials,
      {} as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      status: 'authenticated',
      version: 2,
    });
    expect(driver.verifyAuthenticated).toHaveBeenCalledOnce();
    expect(markSession).toHaveBeenCalledWith(attention, {
      error: null,
      lastVerifiedAt: expect.any(Date),
      status: 'authenticated',
    });
  });

  it('keeps browser attention separate from login expiry before publishing', async () => {
    const attention = browserSession('attention_required');
    const store = {
      getOrCreateSession: vi.fn(async () => attention),
    } as unknown as PostgresBaijiahaoBrowserStore;
    const driver = {
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as BaijiahaoPageDriver;
    const service = new BaijiahaoBrowserService(
      config(),
      store,
      driver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );
    const payload = {
      abstract: '用于验证浏览器安全暂停的摘要。',
      body_asset_ids: [],
      body_html: '<p>用于验证浏览器安全暂停的正文。</p>',
      body_text: '用于验证浏览器安全暂停的正文。',
      citation_links: [],
      content_type: 'news',
      cover_asset_id: null,
      platform_code: 'baijiahao' as const,
      rule_version: 'baijiahao-render-rules@1.1.0' as const,
      schema_version: 'baijiahao-payload@2' as const,
      tags: ['百家号', '安全暂停', '验证'],
      title: '百家号浏览器安全暂停验证',
    };

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'baijiahao-attention-required',
        payload,
        payload_hash: hashBaijiahaoPayload(payload),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_ATTENTION_REQUIRED', statusCode: 423 });
    expect(driver.verifyAuthenticated).not.toHaveBeenCalled();
  });

  it('records pre-submit browser operation failures as manual attention, not unknown', async () => {
    const session = browserSession('authenticated');
    const prepared: PublicationClaim = Object.freeze({
      accountId: ACCOUNT_ID,
      contentVersionId: CONTENT_VERSION_ID,
      id: PUBLICATION_ID,
      idempotencyKey: 'baijiahao-editor-operation-failed',
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
          status: update['status'] as PublicationClaim['status'],
          version: publication.version + 1,
        }),
    );
    const markSession = vi.fn(async () => ({
      ...session,
      status: 'attention_required' as const,
      version: 2,
    }));
    const store = {
      getOrCreateSession: vi.fn(async () => session),
      insertArtifact: vi.fn(async () => undefined),
      loadImageAssets: vi.fn(async () => []),
      markSession,
      preparePublication: vi.fn(async () => prepared),
      updatePublication,
    } as unknown as PostgresBaijiahaoBrowserStore;
    const driver = {
      capture: vi.fn(async () => Buffer.from('attention-required')),
      submit: vi.fn(async () => {
        throw new PageDriverOperationError(
          'upload_body_images',
          new Error('file chooser timed out'),
        );
      }),
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as BaijiahaoPageDriver;
    const credentials = {
      decrypt: vi.fn(async () => '{}'),
    } as unknown as CredentialEnvelopeService;
    const storage = {
      putObject: vi.fn(async () => ({ uri: 'memory://test/attention-required.png' })),
    } as unknown as ObjectStorageAdapter;
    const service = new BaijiahaoBrowserService(config(), store, driver, credentials, storage);
    const payload = {
      abstract: '用于验证提交前浏览器异常的摘要。',
      body_asset_ids: [],
      body_html: '<p>用于验证提交前浏览器异常的正文。</p>',
      body_text: '用于验证提交前浏览器异常的正文。',
      citation_links: [],
      content_type: 'news',
      cover_asset_id: null,
      platform_code: 'baijiahao' as const,
      rule_version: 'baijiahao-render-rules@1.1.0' as const,
      schema_version: 'baijiahao-payload@2' as const,
      tags: ['百家号', '编辑器异常', '验证'],
      title: '百家号提交前浏览器异常验证',
    };

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: prepared.idempotencyKey,
        payload,
        payload_hash: hashBaijiahaoPayload(payload),
      }),
    ).rejects.toMatchObject({
      code: 'EDITOR_OPERATION_FAILED',
      stage: 'upload_body_images',
      statusCode: 423,
    });
    expect(markSession).toHaveBeenCalledWith(session, {
      error: {
        code: 'EDITOR_OPERATION_FAILED',
        schema_version: 'baijiahao-browser-error@1',
        stage: 'upload_body_images',
      },
      status: 'attention_required',
    });
    expect(updatePublication).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'submitting' }),
      { status: 'manual_required' },
    );
  });

  it('redacts browser secrets from diagnostics', () => {
    expect(safeBrowserError(new Error('Cookie: SID=secret; password=hidden'))).toBe(
      'Error: Cookie: [REDACTED]',
    );
  });

  it('keeps nested Playwright causes in safe diagnostics', () => {
    const error = new BrowserGatewayError(
      423,
      'EDITOR_OPERATION_FAILED',
      'manual attention',
      'upload_cover',
      new PageDriverOperationError(
        'upload_cover',
        new Error('locator.click: Timeout 30000ms token=browser-secret'),
      ),
    );

    const safe = safeBrowserError(error);

    expect(safe).toContain('stage=upload_cover');
    expect(safe).toContain('locator.click: Timeout 30000ms');
    expect(safe).not.toContain('browser-secret');
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
  const hasAuthenticatedState = status === 'authenticated' || status === 'attention_required';
  return Object.freeze({
    accountId: ACCOUNT_ID,
    authenticatedAt: hasAuthenticatedState ? new Date('2026-08-02T00:00:00.000Z') : null,
    id: SESSION_ID,
    lastVerifiedAt: hasAuthenticatedState ? new Date('2026-08-02T00:00:00.000Z') : null,
    profileKey: `baijiahao/${TENANT_ID}/${ACCOUNT_ID}`,
    qrExpiresAt: null,
    status,
    storageStateCiphertext: hasAuthenticatedState ? 'encrypted-state' : null,
    storageStateKeyVersion: hasAuthenticatedState ? 'test-v1' : null,
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
