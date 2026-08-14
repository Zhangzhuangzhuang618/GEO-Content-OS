import { hashSohuPayload } from '@geo-content-os/adapter-platforms/sohu/delivery';
import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import {
  CredentialEnvelopeError,
  type CredentialEnvelopeService,
} from '@geo-content-os/security/credentials';
import { describe, expect, it, vi } from 'vitest';

import type { SohuBrowserConfig } from './config.js';
import { PageDriverError, PageDriverOperationError } from './page-driver.js';
import { SohuBrowserService, BrowserGatewayError, safeBrowserError } from './service.js';
import type { PostgresSohuBrowserStore } from './store.js';
import type { SohuPageDriver, BrowserSession, PublicationClaim } from './types.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000145';
const CONTENT_VERSION_ID = '00000000-0000-4000-8000-000000000146';
const PUBLICATION_ID = '00000000-0000-4000-8000-000000000147';
const SESSION_ID = '00000000-0000-4000-8000-000000000148';
const TENANT_ID = '00000000-0000-4000-8000-000000000149';

describe('Sohu browser service', () => {
  it('returns the image captcha challenge without persisting the mobile number', async () => {
    const session = browserSession('login_required');
    const pending = { ...session, version: 2 };
    const markSession = vi.fn(async () => pending);
    const store = {
      getOrCreateSession: vi.fn(async () => session),
      markSession,
    } as unknown as PostgresSohuBrowserStore;
    const driver = {
      startLogin: vi.fn(async () => ({
        captchaPng: Buffer.from('captcha'),
        expiresAt: new Date('2026-08-14T12:00:00.000Z'),
        qrPng: Buffer.alloc(0),
      })),
    } as unknown as SohuPageDriver;
    const service = new SohuBrowserService(
      config(),
      store,
      driver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(
      service.startLogin(ACCOUNT_ID, { method: 'sms_prepare', mobile: '13800138000' }),
    ).resolves.toMatchObject({
      captcha_image_data_url: `data:image/png;base64,${Buffer.from('captcha').toString('base64')}`,
      login_stage: 'captcha_required',
      status: 'login_required',
    });
    expect(markSession).toHaveBeenCalledWith(session, {
      error: null,
      qrExpiresAt: null,
      status: 'login_required',
    });
    expect(JSON.stringify(markSession.mock.calls)).not.toContain('13800138000');
  });

  it('returns the SMS challenge without persisting either verification code', async () => {
    const session = browserSession('login_required');
    const pending = { ...session, version: 2 };
    const markSession = vi.fn(async () => pending);
    const store = {
      getOrCreateSession: vi.fn(async () => session),
      markSession,
    } as unknown as PostgresSohuBrowserStore;
    const driver = {
      startLogin: vi.fn(async () => ({
        expiresAt: new Date('2026-08-14T12:00:00.000Z'),
        qrPng: Buffer.alloc(0),
        smsCodeRequired: true,
      })),
    } as unknown as SohuPageDriver;
    const service = new SohuBrowserService(
      config(),
      store,
      driver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(
      service.startLogin(ACCOUNT_ID, {
        accepted_terms: true,
        image_captcha: 'image-code',
        method: 'sms_send',
        mobile: '13800138000',
      }),
    ).resolves.toMatchObject({
      login_stage: 'sms_code_required',
      status: 'login_required',
    });
    expect(JSON.stringify(markSession.mock.calls)).not.toMatch(/13800138000|image-code/u);
  });

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
    } as unknown as PostgresSohuBrowserStore;
    const driver = {
      startLogin: vi.fn(async () => {
        throw new PageDriverError(
          'PAGE_SIGNATURE_CHANGED',
          'Sohu login entry no longer matches the frozen page signature',
        );
      }),
    } as unknown as SohuPageDriver;
    const service = new SohuBrowserService(
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
        schema_version: 'sohu-browser-error@1',
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
    } as unknown as PostgresSohuBrowserStore;
    const driver = {
      startLogin: vi.fn(async () => ({ expiresAt, qrPng: Buffer.from('qr') })),
      waitForAuthentication: vi.fn(async () => {
        throw new Error('page.goto: net::ERR_ABORTED token=login-secret');
      }),
    } as unknown as SohuPageDriver;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new SohuBrowserService(
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
          schema_version: 'sohu-browser-error@1',
        },
        qrExpiresAt: null,
        status: 'attention_required',
      }),
    );
    expect(errorLog).toHaveBeenCalledWith(
      'Sohu browser login verification failed',
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
    } as unknown as PostgresSohuBrowserStore;
    const credentials = {
      decrypt: vi.fn(async () => {
        throw new CredentialEnvelopeError('CREDENTIAL_DECRYPTION_FAILED');
      }),
    } as unknown as CredentialEnvelopeService;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new SohuBrowserService(
      config(),
      store,
      {} as SohuPageDriver,
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
        schema_version: 'sohu-browser-error@1',
      },
      status: 'reauth',
    });
    expect(errorLog).toHaveBeenCalledWith(
      'Sohu browser session verification failed',
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
    } as unknown as PostgresSohuBrowserStore;
    const driver = {
      verifyAuthenticated: vi.fn(async () => {
        throw new Error('Chromium failed token=browser-secret');
      }),
    } as unknown as SohuPageDriver;
    const credentials = {
      decrypt: vi.fn(async () => '{}'),
    } as unknown as CredentialEnvelopeService;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new SohuBrowserService(
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
      error: { code: 'BROWSER_RUNTIME_FAILED', schema_version: 'sohu-browser-error@1' },
      status: 'attention_required',
    });
    expect(errorLog).toHaveBeenCalledWith(
      'Sohu browser session verification failed',
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
    } as unknown as PostgresSohuBrowserStore;
    const driver = {
      verifyAuthenticated: vi.fn(async () => {
        throw new PageDriverError('CAPTCHA_REQUIRED', 'Sohu requested human verification');
      }),
    } as unknown as SohuPageDriver;
    const credentials = {
      decrypt: vi.fn(async () => '{}'),
    } as unknown as CredentialEnvelopeService;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new SohuBrowserService(
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
      error: { code: 'CAPTCHA_REQUIRED', schema_version: 'sohu-browser-error@1' },
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
    } as unknown as PostgresSohuBrowserStore;
    const service = new SohuBrowserService(
      config(),
      store,
      { verifyAuthenticated } as unknown as SohuPageDriver,
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
    } as unknown as PostgresSohuBrowserStore;
    const driver = {
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as SohuPageDriver;
    const credentials = {
      decrypt: vi.fn(async () => '{}'),
    } as unknown as CredentialEnvelopeService;
    const service = new SohuBrowserService(
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
    } as unknown as PostgresSohuBrowserStore;
    const driver = {
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as SohuPageDriver;
    const service = new SohuBrowserService(
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
      platform_code: 'sohu' as const,
      rule_version: 'sohu-render-rules@1.0.0' as const,
      schema_version: 'sohu-payload@1' as const,
      ai_generated: true as const,
      original: false as const,
      title: '搜狐号浏览器安全暂停验证',
    };

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'sohu-attention-required',
        payload,
        payload_hash: hashSohuPayload(payload),
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
      idempotencyKey: 'sohu-editor-operation-failed',
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
    } as unknown as PostgresSohuBrowserStore;
    const driver = {
      capture: vi.fn(async () => Buffer.from('attention-required')),
      submit: vi.fn(async () => {
        throw new PageDriverOperationError(
          'upload_body_images',
          new Error('file chooser timed out'),
        );
      }),
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as SohuPageDriver;
    const credentials = {
      decrypt: vi.fn(async () => '{}'),
    } as unknown as CredentialEnvelopeService;
    const storage = {
      putObject: vi.fn(async () => ({ uri: 'memory://test/attention-required.png' })),
    } as unknown as ObjectStorageAdapter;
    const service = new SohuBrowserService(config(), store, driver, credentials, storage);
    const payload = {
      abstract: '用于验证提交前浏览器异常的摘要。',
      body_asset_ids: [],
      body_html: '<p>用于验证提交前浏览器异常的正文。</p>',
      body_text: '用于验证提交前浏览器异常的正文。',
      citation_links: [],
      content_type: 'news',
      cover_asset_id: null,
      platform_code: 'sohu' as const,
      rule_version: 'sohu-render-rules@1.0.0' as const,
      schema_version: 'sohu-payload@1' as const,
      ai_generated: true as const,
      original: false as const,
      title: '搜狐号提交前浏览器异常验证',
    };

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: prepared.idempotencyKey,
        payload,
        payload_hash: hashSohuPayload(payload),
      }),
    ).rejects.toMatchObject({
      code: 'EDITOR_OPERATION_FAILED',
      stage: 'upload_body_images',
      statusCode: 423,
    });
    expect(markSession).toHaveBeenCalledWith(session, {
      error: {
        code: 'EDITOR_OPERATION_FAILED',
        schema_version: 'sohu-browser-error@1',
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
      idempotencyKey: 'sohu-t150-rejected',
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
    } as unknown as PostgresSohuBrowserStore;
    const driver = {
      capture: vi.fn(async () => Buffer.from('post-submit')),
      submit: vi.fn(async () => ({
        externalId: 'rejected-145',
        reviewReason: '内容未通过审核',
        status: 'failed' as const,
        url: null,
      })),
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as SohuPageDriver;
    const credentials = {
      decrypt: vi.fn(async () => '{}'),
    } as unknown as CredentialEnvelopeService;
    const storage = {
      putObject: vi.fn(async () => ({ uri: 'memory://test/post-submit.png' })),
    } as unknown as ObjectStorageAdapter;
    const service = new SohuBrowserService(config(), store, driver, credentials, storage);
    const payload = {
      abstract: '用于验证搜狐号驳回处理的摘要。',
      body_asset_ids: [],
      body_html: '<p>用于验证搜狐号驳回处理的正文。</p>',
      body_text: '用于验证搜狐号驳回处理的正文。',
      citation_links: [],
      content_type: 'news',
      cover_asset_id: null,
      platform_code: 'sohu' as const,
      rule_version: 'sohu-render-rules@1.0.0' as const,
      schema_version: 'sohu-payload@1' as const,
      ai_generated: true as const,
      original: false as const,
      title: '搜狐号驳回状态验证',
    };

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: prepared.idempotencyKey,
        payload,
        payload_hash: hashSohuPayload(payload),
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
    profileKey: `sohu/${TENANT_ID}/${ACCOUNT_ID}`,
    qrExpiresAt: null,
    status,
    storageStateCiphertext: hasAuthenticatedState ? 'encrypted-state' : null,
    storageStateKeyVersion: hasAuthenticatedState ? 'test-v1' : null,
    tenantId: TENANT_ID,
    version: 1,
  });
}

function config(): SohuBrowserConfig {
  return Object.freeze({
    databaseUrl: 'postgresql://unused',
    editorUrl: 'https://sohu.example/editor',
    gatewayToken: 'x'.repeat(32),
    headless: true,
    healthPort: 9095,
    loginUrl: 'https://sohu.example/login',
    manageUrl: 'https://sohu.example/manage',
    navigationTimeoutMs: 5_000,
    profileRoot: '/tmp/geo-sohu-service-test',
    simulator: true,
  });
}
