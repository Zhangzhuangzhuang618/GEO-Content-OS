import { createHash } from 'node:crypto';

import { hashDouyinPayload } from '@geo-content-os/adapter-platforms/douyin/delivery';
import type { DouyinImageNotePayload } from '@geo-content-os/adapter-platforms/douyin/render';
import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import type { CredentialEnvelopeService } from '@geo-content-os/security/credentials';
import { describe, expect, it, vi } from 'vitest';

import type { DouyinBrowserConfig } from './config.js';
import { PageDriverError } from './page-driver.js';
import { DouyinBrowserService } from './service.js';
import type { PostgresDouyinBrowserStore, PublicationRow } from './store.js';
import type { BrowserSession, DouyinPageDriver, LoginVerificationDiagnostic } from './types.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000158';
const CONTENT_VERSION_ID = '00000000-0000-4000-8000-000000000159';
const PUBLICATION_ID = '00000000-0000-4000-8000-000000000160';
const SESSION_ID = '00000000-0000-4000-8000-000000000161';
const TENANT_ID = '00000000-0000-4000-8000-000000000162';
const IMAGE_IDS = Array.from(
  { length: 5 },
  (_, index) => `00000000-0000-4000-8000-${String(170 + index).padStart(12, '0')}`,
);

describe('Douyin browser service', () => {
  it('rejects legacy script packages before opening the browser', async () => {
    const service = new DouyinBrowserService(
      config(),
      {} as PostgresDouyinBrowserStore,
      {} as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );
    const payload = {
      citation_links: [],
      duration_seconds: 15,
      hook: '测试开场',
      platform_code: 'douyin',
      rule_version: 'douyin-render-rules@1.0.0',
      schema_version: 'douyin-payload@1',
      script_kind: 'script_package',
      script_text: '测试脚本',
      storyboard: [
        {
          end_second: 15,
          scene_key: 'scene-1',
          start_second: 0,
          visual: '测试画面',
          voiceover: '测试旁白',
        },
      ],
      subtitles: [{ end_second: 15, start_second: 0, text: '测试字幕' }],
      title: '测试视频脚本',
      topics: ['测试'],
    } as const;

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:legacy:script',
        payload,
        payload_hash: hashDouyinPayload(payload),
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_KIND_UNSUPPORTED', statusCode: 409 });
  });

  it('uploads frozen images in payload order and records pre-submit evidence', async () => {
    const payload = imageNotePayload();
    const session = browserSession();
    const prepared = publication('prepared', 1);
    const submitting = publication('submitting', 2);
    const processing = {
      ...publication('processing', 3),
      externalId: 'remote-note-158',
    };
    const body = Buffer.from('card-image');
    const contentHash = createHash('sha256').update(body).digest('hex');
    const updatePublication = vi
      .fn()
      .mockResolvedValueOnce(submitting)
      .mockResolvedValueOnce(processing);
    const store = {
      getOrCreateSession: vi.fn(async () => session),
      insertArtifact: vi.fn(async () => undefined),
      loadImageAssets: vi.fn(async () =>
        IMAGE_IDS.map((assetId) => ({
          assetId,
          contentHash,
          mimeType: 'image/jpeg' as const,
          objectUri: `memory://geo/${assetId}.jpg`,
          sizeBytes: body.byteLength,
        })),
      ),
      preparePublication: vi.fn(async () => prepared),
      updatePublication,
    } as unknown as PostgresDouyinBrowserStore;
    const submit = vi.fn(async (input, beforeSubmit: (png: Uint8Array) => Promise<void>) => {
      await beforeSubmit(Buffer.from('pre-submit'));
      expect(input.images.map((image: { assetId: string }) => image.assetId)).toEqual(IMAGE_IDS);
      return {
        externalId: 'remote-note-158',
        reviewReason: null,
        status: 'processing' as const,
        url: null,
      };
    });
    const driver = {
      capture: vi.fn(async () => Buffer.from('post-submit')),
      submit,
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as DouyinPageDriver;
    const storage = {
      getObject: vi.fn(async () => body),
      putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
    } as unknown as ObjectStorageAdapter;
    const service = new DouyinBrowserService(
      config(),
      store,
      driver,
      {
        decrypt: vi.fn(async () => '{}'),
      } as unknown as CredentialEnvelopeService,
      storage,
    );

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:158',
        payload,
        payload_hash: hashDouyinPayload(payload),
      }),
    ).resolves.toEqual({
      external_id: 'remote-note-158',
      status: 'processing',
      url: null,
    });
    expect(store.loadImageAssets).toHaveBeenCalledWith(prepared, IMAGE_IDS);
    expect(submit).toHaveBeenCalledOnce();
    expect(store.insertArtifact).toHaveBeenCalledTimes(2);
  });

  it('persists an asynchronous QR verification failure for operator recovery', async () => {
    const failureLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const initial = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      status: 'login_required' as const,
    });
    const pending = Object.freeze({
      ...initial,
      qrExpiresAt: new Date(Date.now() + 60_000),
      status: 'qr_ready' as const,
      version: 2,
    });
    const markSession = vi
      .fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(
        Object.freeze({
          ...pending,
          qrExpiresAt: null,
          status: 'attention_required' as const,
          version: 3,
        }),
      );
    const store = {
      getOrCreateSession: vi.fn(async () => initial),
      getSession: vi.fn(async () => pending),
      markSession,
    } as unknown as PostgresDouyinBrowserStore;
    const service = new DouyinBrowserService(
      config(),
      store,
      {
        startLogin: vi.fn(async () => ({
          expiresAt: pending.qrExpiresAt!,
          qrPng: Buffer.from('qr'),
        })),
        waitForAuthentication: vi.fn(async () => {
          throw new Error('browser process exited');
        }),
      } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.startLogin(ACCOUNT_ID)).resolves.toMatchObject({ status: 'qr_ready' });
    await vi.waitFor(() => expect(markSession).toHaveBeenCalledTimes(2));
    expect(markSession.mock.calls[1]?.[1]).toMatchObject({
      error: { code: 'LOGIN_VERIFICATION_FAILED' },
      qrExpiresAt: null,
      status: 'attention_required',
    });
    expect(failureLog).toHaveBeenCalledWith(
      'Douyin browser login verification failed',
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        error: expect.stringContaining('browser process exited'),
      }),
    );
    failureLog.mockRestore();
  });

  it('stores only a redacted diagnostic when QR authorization reaches a security challenge', async () => {
    const initial = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      status: 'login_required' as const,
    });
    const pending = Object.freeze({
      ...initial,
      qrExpiresAt: new Date(Date.now() + 60_000),
      status: 'qr_ready' as const,
      version: 2,
    });
    const attention = Object.freeze({
      ...pending,
      qrExpiresAt: null,
      status: 'attention_required' as const,
      version: 3,
    });
    const markSession = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(attention);
    const diagnostic = loginVerificationDiagnostic();
    const diagnosticLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failureLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const putObject = vi.fn(async ({ key }: { key: string }) => ({
      uri: `memory://geo/${key}`,
    }));
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => initial),
        getSession: vi.fn(async () => pending),
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification: vi.fn(async () => diagnostic),
        startLogin: vi.fn(async () => ({
          expiresAt: pending.qrExpiresAt!,
          qrPng: Buffer.from('login-qr'),
        })),
        waitForAuthentication: vi.fn(async () => {
          throw new PageDriverError('CAPTCHA_REQUIRED', 'security challenge');
        }),
      } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      { putObject } as unknown as ObjectStorageAdapter,
    );

    await expect(service.startLogin(ACCOUNT_ID)).resolves.toMatchObject({ status: 'qr_ready' });
    await vi.waitFor(() => expect(markSession).toHaveBeenCalledTimes(2));

    const persisted = markSession.mock.calls[1]?.[1];
    expect(persisted).toMatchObject({
      error: {
        code: 'CAPTCHA_REQUIRED',
        verification: {
          available_methods: ['sms_code', 'original_device_scan'],
          challenge_type: 'identity_choice',
          control_evidence: {
            code_input_actionable: false,
            code_input_editable: false,
            code_input_enabled: false,
            code_input_hit_target: false,
            code_input_step_actionable: false,
            code_input_visible: false,
            face_verification_option_visible: true,
            foreground_dialog_visible: true,
            original_device_option_visible: true,
            receive_sms_option_visible: true,
            send_sms_option_visible: true,
            submit_control_actionable: false,
            submit_control_enabled: false,
            submit_control_hit_target: false,
            submit_control_visible: false,
            visual_captcha_visible: false,
          },
          page_origin: 'https://creator.douyin.com',
          page_path: '/passport/safe/verify',
          schema_version: 'douyin-login-verification-diagnostic@3',
        },
      },
      qrExpiresAt: null,
      status: 'attention_required',
    });
    expect(JSON.stringify(persisted)).not.toContain('13800138000');
    expect(JSON.stringify(persisted)).not.toContain('654321');
    expect(JSON.stringify(persisted)).not.toContain('diagnostic-png');
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        body: diagnostic.screenshotPng,
        contentType: 'image/png',
        metadata: { kind: 'login_verification', session_id: SESSION_ID },
      }),
    );
    expect(diagnosticLog).toHaveBeenCalledWith(
      'Douyin browser login requires additional verification',
      {
        account_id: ACCOUNT_ID,
        error_code: 'CAPTCHA_REQUIRED',
      },
    );
    expect(diagnosticLog).toHaveBeenCalledWith(
      'Douyin login verification diagnostic captured',
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        challenge_type: 'identity_choice',
        code: 'CAPTCHA_REQUIRED',
        control_evidence: expect.objectContaining({
          code_input_actionable: false,
          foreground_dialog_visible: true,
          receive_sms_option_visible: true,
          send_sms_option_visible: true,
        }),
        screenshot_content_hash: createHash('sha256')
          .update(diagnostic.screenshotPng)
          .digest('hex'),
        screenshot_object_uri: expect.stringContaining('login-verification-'),
      }),
    );
    expect(JSON.stringify(diagnosticLog.mock.calls)).not.toContain('13800138000');
    expect(JSON.stringify(diagnosticLog.mock.calls)).not.toContain('654321');
    expect(failureLog).not.toHaveBeenCalled();
    diagnosticLog.mockRestore();
    failureLog.mockRestore();
  });

  it('does not let an older QR attempt overwrite a newer login attempt', async () => {
    const attentionLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failureLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const initial = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      status: 'login_required' as const,
    });
    const pending = Object.freeze({
      ...initial,
      qrExpiresAt: new Date(Date.now() + 60_000),
      status: 'qr_ready' as const,
      version: 2,
    });
    const newerPending = Object.freeze({
      ...pending,
      qrExpiresAt: new Date(pending.qrExpiresAt!.getTime() + 60_000),
      version: 3,
    });
    const markSession = vi.fn(async () => pending);
    const getSession = vi.fn(async () => newerPending);
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => initial),
        getSession,
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        startLogin: vi.fn(async () => ({
          expiresAt: pending.qrExpiresAt!,
          qrPng: Buffer.from('qr'),
        })),
        waitForAuthentication: vi.fn(async () => {
          throw new Error('older browser attempt exited');
        }),
      } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.startLogin(ACCOUNT_ID)).resolves.toMatchObject({ status: 'qr_ready' });
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());
    expect(markSession).toHaveBeenCalledOnce();
    expect(attentionLog).not.toHaveBeenCalled();
    expect(failureLog).not.toHaveBeenCalled();
    attentionLog.mockRestore();
    failureLog.mockRestore();
  });

  it('keeps a pending security challenge recoverable while authentication is incomplete', async () => {
    const attention = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      lastVerifiedAt: null,
      status: 'attention_required' as const,
      storageStateCiphertext: null,
      storageStateKeyVersion: null,
    });
    const markSession = vi.fn();
    const markAccountReauth = vi.fn();
    const service = new DouyinBrowserService(
      config(),
      {
        getSession: vi.fn(async () => attention),
        markAccountReauth,
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification: vi.fn(async () => null),
        verifyAuthenticated: vi.fn(async () => false),
      } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      status: 'attention_required',
    });
    expect(markSession).not.toHaveBeenCalled();
    expect(markAccountReauth).not.toHaveBeenCalled();
  });

  it('returns a live security challenge without navigating away during status polling', async () => {
    const attention = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      lastVerifiedAt: null,
      status: 'attention_required' as const,
      storageStateCiphertext: null,
      storageStateKeyVersion: null,
    });
    const diagnostic = loginVerificationDiagnostic();
    const verifyAuthenticated = vi.fn();
    const service = new DouyinBrowserService(
      config(),
      { getSession: vi.fn(async () => attention) } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification: vi.fn(async () => diagnostic),
        verifyAuthenticated,
      } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      status: 'attention_required',
      verification: {
        available_methods: ['sms_code', 'original_device_scan'],
        challenge_type: 'identity_choice',
        diagnostic_image_data_url: `data:image/png;base64,${Buffer.from(
          diagnostic.screenshotPng,
        ).toString('base64')}`,
      },
    });
    expect(verifyAuthenticated).not.toHaveBeenCalled();
  });

  it('returns the last verified redacted diagnostic after the browser page is no longer live', async () => {
    const screenshot = Buffer.from('stored-redacted-diagnostic');
    const contentHash = createHash('sha256').update(screenshot).digest('hex');
    const attention = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      lastError: {
        code: 'CAPTCHA_REQUIRED',
        verification: {
          available_methods: ['sms_code'],
          captured_at: '2026-08-28T07:36:24.000Z',
          challenge_type: 'sms_code',
          content_hash: contentHash,
          has_code_input: true,
          object_uri: 'memory://geo/douyin-browser/redacted.png',
          page_origin: 'https://creator.douyin.com',
          page_path: '/passport/safe/verify',
          page_signature: 'a'.repeat(64),
          schema_version: 'douyin-login-verification-diagnostic@1',
        },
      },
      lastVerifiedAt: null,
      status: 'attention_required' as const,
      storageStateCiphertext: null,
      storageStateKeyVersion: null,
    });
    const getObject = vi.fn(async () => screenshot);
    const service = new DouyinBrowserService(
      config(),
      { getSession: vi.fn(async () => attention) } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification: vi.fn(async () => null),
        verifyAuthenticated: vi.fn(async () => false),
      } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      { getObject } as unknown as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      status: 'attention_required',
      verification: {
        challenge_type: 'sms_code',
        diagnostic_image_data_url: `data:image/png;base64,${screenshot.toString('base64')}`,
        has_code_input: true,
      },
    });
    expect(getObject).toHaveBeenCalledWith('douyin-browser/redacted.png');
  });

  it('persists the authenticated session after SMS verification without persisting the code', async () => {
    const attention = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      lastVerifiedAt: null,
      status: 'attention_required' as const,
      storageStateCiphertext: null,
      storageStateKeyVersion: null,
    });
    const authenticated = Object.freeze({
      ...attention,
      authenticatedAt: new Date('2026-08-28T08:00:00.000Z'),
      lastVerifiedAt: new Date('2026-08-28T08:00:00.000Z'),
      status: 'authenticated' as const,
      storageStateCiphertext: 'new-ciphertext',
      storageStateKeyVersion: 'local-v2',
      version: 2,
    });
    const markSession = vi.fn(async () => authenticated);
    const submitLoginVerification = vi.fn(async () => null);
    const actionLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const encrypt = vi.fn(async () => ({
      credentialCiphertext: 'new-ciphertext',
      credentialKeyVersion: 'local-v2',
    }));
    const service = new DouyinBrowserService(
      config(),
      {
        getSession: vi.fn(async () => attention),
        markAccountActive: vi.fn(async () => undefined),
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        exportStorageState: vi.fn(async () => '{"cookies":[{"name":"sid","value":"safe"}]}'),
        submitLoginVerification,
      } as unknown as DouyinPageDriver,
      { encrypt } as unknown as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(
      service.startLogin(ACCOUNT_ID, {
        method: 'verification_sms_verify',
        sms_code: '654321',
      }),
    ).resolves.toMatchObject({ status: 'authenticated' });
    expect(submitLoginVerification).toHaveBeenCalledWith(ACCOUNT_ID, {
      method: 'verification_sms_verify',
      sms_code: '654321',
    });
    expect(encrypt).toHaveBeenCalledWith('{"cookies":[{"name":"sid","value":"safe"}]}');
    expect(JSON.stringify(markSession.mock.calls)).not.toContain('654321');
    expect(actionLog).toHaveBeenCalledWith('Douyin login verification action requested', {
      account_id: ACCOUNT_ID,
      method: 'verification_sms_verify',
    });
    expect(JSON.stringify(actionLog.mock.calls)).not.toContain('654321');
    actionLog.mockRestore();
  });

  it('persists credentials and reactivates the account after a security challenge succeeds', async () => {
    const attention = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      lastVerifiedAt: null,
      status: 'attention_required' as const,
      storageStateCiphertext: null,
      storageStateKeyVersion: null,
    });
    const authenticated = Object.freeze({
      ...attention,
      authenticatedAt: new Date('2026-08-26T01:00:00.000Z'),
      lastVerifiedAt: new Date('2026-08-26T01:00:00.000Z'),
      status: 'authenticated' as const,
      storageStateCiphertext: 'new-ciphertext',
      storageStateKeyVersion: 'local-v2',
      version: 2,
    });
    const markSession = vi.fn(async () => authenticated);
    const markAccountActive = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getSession: vi.fn(async () => attention),
        markAccountActive,
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        exportStorageState: vi.fn(async () => '{"cookies":[]}'),
        inspectLoginVerification: vi.fn(async () => null),
        verifyAuthenticated: vi.fn(async () => true),
      } as unknown as DouyinPageDriver,
      {
        encrypt: vi.fn(async () => ({
          credentialCiphertext: 'new-ciphertext',
          credentialKeyVersion: 'local-v2',
        })),
      } as unknown as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      status: 'authenticated',
    });
    expect(markSession).toHaveBeenCalledWith(
      attention,
      expect.objectContaining({
        error: null,
        status: 'authenticated',
        storageStateCiphertext: 'new-ciphertext',
        storageStateKeyVersion: 'local-v2',
      }),
    );
    expect(markAccountActive).toHaveBeenCalledWith(ACCOUNT_ID, TENANT_ID);
  });

  it('never resubmits an unresolved prior submission automatically', async () => {
    const session = browserSession();
    const unresolved = Object.freeze({
      ...publication('unknown', 2),
      submittedAt: new Date(Date.now() - 3 * 60_000),
    });
    const manual = Object.freeze({ ...unresolved, status: 'manual_required' as const, version: 3 });
    const updatePublication = vi.fn(async () => manual);
    const store = {
      getOrCreateSession: vi.fn(async () => session),
      insertArtifact: vi.fn(async () => undefined),
      preparePublication: vi.fn(async () => unresolved),
      updatePublication,
    } as unknown as PostgresDouyinBrowserStore;
    const driver = {
      capture: vi.fn(async () => Buffer.from('unresolved-state')),
      reconcile: vi.fn(async () => null),
      submit: vi.fn(),
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as DouyinPageDriver;
    const service = new DouyinBrowserService(
      config(),
      store,
      driver,
      { decrypt: vi.fn(async () => '{}') } as unknown as CredentialEnvelopeService,
      {
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );
    const payload = imageNotePayload();

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:158',
        payload,
        payload_hash: hashDouyinPayload(payload),
      }),
    ).rejects.toMatchObject({ code: 'PUBLISH_STATE_UNKNOWN', statusCode: 423 });
    expect(updatePublication).toHaveBeenCalledWith(unresolved, { status: 'manual_required' });
    expect(driver.submit).not.toHaveBeenCalled();
  });

  it('reconciles a manual-required publication after authentication is restored', async () => {
    const fingerprint = 'a'.repeat(64);
    const manual = Object.freeze({
      ...publication('manual_required', 3),
      externalId: fingerprint,
    });
    const remote = Object.freeze({
      externalId: '7678487251839470902',
      reviewReason: null,
      status: 'published' as const,
      url: 'https://www.douyin.com/note/7678487251839470902',
    });
    const published = Object.freeze({
      ...manual,
      externalId: remote.externalId,
      externalUrl: remote.url,
      status: 'published' as const,
      version: 4,
    });
    const updatePublication = vi.fn(async () => published);
    const store = {
      findPublication: vi.fn(async () => manual),
      getSession: vi.fn(async () => browserSession()),
      insertArtifact: vi.fn(async () => undefined),
      updatePublication,
    } as unknown as PostgresDouyinBrowserStore;
    const reconcile = vi.fn(async () => remote);
    const service = new DouyinBrowserService(
      config(),
      store,
      {
        capture: vi.fn(async () => Buffer.from('reconciled-publication')),
        reconcile,
      } as unknown as DouyinPageDriver,
      { decrypt: vi.fn(async () => '{}') } as unknown as CredentialEnvelopeService,
      {
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );

    await expect(service.status(ACCOUNT_ID, fingerprint)).resolves.toEqual({
      external_id: remote.externalId,
      status: 'published',
      url: remote.url,
    });
    expect(updatePublication).toHaveBeenCalledWith(manual, {
      remote,
      status: 'published',
    });
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('preserves manual-required state when authenticated reconciliation finds no match', async () => {
    const fingerprint = 'a'.repeat(64);
    const manual = Object.freeze({
      ...publication('manual_required', 3),
      externalId: fingerprint,
    });
    const updatePublication = vi.fn();
    const reconcile = vi.fn(async () => null);
    const service = new DouyinBrowserService(
      config(),
      {
        findPublication: vi.fn(async () => manual),
        getSession: vi.fn(async () => browserSession()),
        updatePublication,
      } as unknown as PostgresDouyinBrowserStore,
      { reconcile } as unknown as DouyinPageDriver,
      { decrypt: vi.fn(async () => '{}') } as unknown as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.status(ACCOUNT_ID, fingerprint)).resolves.toEqual({
      external_id: fingerprint,
      status: 'unknown',
      url: null,
    });
    expect(updatePublication).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('does not reconcile manual-required state before authentication is restored', async () => {
    const fingerprint = 'a'.repeat(64);
    const manual = Object.freeze({
      ...publication('manual_required', 3),
      externalId: fingerprint,
    });
    const reconcile = vi.fn();
    const service = new DouyinBrowserService(
      config(),
      {
        findPublication: vi.fn(async () => manual),
        getSession: vi.fn(async () => ({
          ...browserSession(),
          status: 'attention_required' as const,
        })),
      } as unknown as PostgresDouyinBrowserStore,
      { reconcile } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.status(ACCOUNT_ID, fingerprint)).resolves.toMatchObject({
      external_id: fingerprint,
      status: 'unknown',
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('does not enter submitting when frozen image validation fails', async () => {
    const payload = imageNotePayload();
    const prepared = publication('prepared', 1);
    const store = {
      getOrCreateSession: vi.fn(async () => browserSession()),
      loadImageAssets: vi.fn(async () => {
        throw new Error('object storage unavailable');
      }),
      preparePublication: vi.fn(async () => prepared),
      updatePublication: vi.fn(),
    } as unknown as PostgresDouyinBrowserStore;
    const driver = {
      submit: vi.fn(),
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as DouyinPageDriver;
    const service = new DouyinBrowserService(
      config(),
      store,
      driver,
      { decrypt: vi.fn(async () => '{}') } as unknown as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:invalid-assets',
        payload,
        payload_hash: hashDouyinPayload(payload),
      }),
    ).rejects.toThrow('object storage unavailable');
    expect(store.updatePublication).not.toHaveBeenCalled();
    expect(driver.submit).not.toHaveBeenCalled();
  });
});

function config(): DouyinBrowserConfig {
  return Object.freeze({
    databaseUrl: 'postgresql://localhost/geo',
    editorUrl: 'https://creator.douyin.com/creator-micro/content/upload',
    gatewayToken: 'x'.repeat(32),
    headless: true,
    healthPort: 9098,
    loginUrl: 'https://creator.douyin.com/',
    manageUrl: 'https://creator.douyin.com/creator-micro/content/manage',
    navigationTimeoutMs: 30_000,
    profileRoot: '/tmp/douyin-browser-tests',
    simulator: false,
  });
}

function browserSession(): BrowserSession {
  return Object.freeze({
    accountId: ACCOUNT_ID,
    authenticatedAt: new Date('2026-08-26T00:00:00.000Z'),
    id: SESSION_ID,
    lastError: null,
    lastVerifiedAt: new Date('2026-08-26T00:00:00.000Z'),
    profileKey: `douyin/${TENANT_ID}/${ACCOUNT_ID}`,
    qrExpiresAt: null,
    status: 'authenticated',
    storageStateCiphertext: 'ciphertext',
    storageStateKeyVersion: 'local-v1',
    tenantId: TENANT_ID,
    version: 1,
  });
}

function loginVerificationDiagnostic(): LoginVerificationDiagnostic {
  return Object.freeze({
    availableMethods: Object.freeze(['sms_code', 'original_device_scan'] as const),
    capturedAt: new Date('2026-08-28T07:36:24.000Z'),
    challengeType: 'identity_choice',
    controlEvidence: Object.freeze({
      codeInputActionable: false,
      codeInputEditable: false,
      codeInputEnabled: false,
      codeInputHitTarget: false,
      codeInputStepActionable: false,
      codeInputVisible: false,
      faceVerificationOptionVisible: true,
      foregroundDialogVisible: true,
      originalDeviceOptionVisible: true,
      receiveSmsOptionVisible: true,
      sendSmsOptionVisible: true,
      submitControlActionable: false,
      submitControlEnabled: false,
      submitControlHitTarget: false,
      submitControlVisible: false,
      visualCaptchaVisible: false,
    }),
    hasCodeInput: false,
    pageOrigin: 'https://creator.douyin.com',
    pagePath: '/passport/safe/verify',
    pageSignature: 'a'.repeat(64),
    qrPng: null,
    screenshotPng: Buffer.from('diagnostic-png'),
  });
}

function publication(status: PublicationRow['status'], version: number): PublicationRow {
  return Object.freeze({
    accountId: ACCOUNT_ID,
    contentFingerprint: 'a'.repeat(64),
    contentVersionId: CONTENT_VERSION_ID,
    externalId: null,
    externalUrl: null,
    id: PUBLICATION_ID,
    idempotencyKey: 'douyin:image-note:158',
    publishJobId: '00000000-0000-4000-8000-000000000163',
    reviewReason: null,
    sessionId: SESSION_ID,
    status,
    submittedAt: status === 'prepared' ? null : new Date('2026-08-26T00:01:00.000Z'),
    tenantId: TENANT_ID,
    title: '搬家前先看这五项',
    version,
  });
}

function imageNotePayload(): DouyinImageNotePayload {
  return Object.freeze({
    ai_generated: true,
    cards: Object.freeze(
      IMAGE_IDS.map((_, index) =>
        Object.freeze({
          body: `第${index + 1}页内容`,
          card_key: `card-${index + 1}`,
          heading: `第${index + 1}项`,
          kind:
            index === 0
              ? ('cover' as const)
              : index === 4
                ? ('summary' as const)
                : ('body' as const),
        }),
      ),
    ),
    citation_links: Object.freeze([]),
    content_kind: 'image_note',
    description: '搬家前核对服务范围、报价边界和验收方式。',
    image_asset_ids: Object.freeze(IMAGE_IDS),
    platform_code: 'douyin',
    rule_version: 'douyin-render-rules@1.0.0',
    schema_version: 'douyin-image-note-payload@1',
    title: '搬家前先看这五项',
    topics: Object.freeze(['搬家准备', '广州搬家']),
  });
}
