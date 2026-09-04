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
import type {
  BrowserSession,
  DouyinPageDriver,
  LoginVerificationDiagnostic,
  LoginVerificationSnapshot,
} from './types.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000158';
const SECOND_ACCOUNT_ID = '00000000-0000-4000-8000-000000000258';
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
    const verified = Object.freeze({ ...session, version: session.version + 1 });
    const finallyVerified = Object.freeze({ ...verified, version: verified.version + 1 });
    const body = Buffer.from('card-image');
    const contentHash = createHash('sha256').update(body).digest('hex');
    const updatePublication = vi
      .fn()
      .mockResolvedValueOnce(submitting)
      .mockResolvedValueOnce(processing);
    const markSession = vi
      .fn()
      .mockResolvedValueOnce(verified)
      .mockResolvedValueOnce(finallyVerified);
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
      markSession,
      preparePublication: vi.fn(async () => prepared),
      updatePublication,
    } as unknown as PostgresDouyinBrowserStore;
    const refreshedStorageState = '{"cookies":[{"name":"sid","value":"refreshed"}]}';
    const finalStorageState = '{"cookies":[{"name":"sid","value":"after-submit"}]}';
    const submit = vi.fn(async (input, beforeSubmit: (png: Uint8Array) => Promise<void>) => {
      await beforeSubmit(Buffer.from('pre-submit'));
      expect(input.images.map((image: { assetId: string }) => image.assetId)).toEqual(IMAGE_IDS);
      expect(input.storageStateJson).toBe(refreshedStorageState);
      return {
        externalId: 'remote-note-158',
        reviewReason: null,
        status: 'processing' as const,
        url: null,
      };
    });
    const exportStorageState = vi
      .fn()
      .mockResolvedValueOnce(refreshedStorageState)
      .mockResolvedValueOnce(finalStorageState);
    const release = vi.fn(async () => undefined);
    const driver = {
      capture: vi.fn(async () => Buffer.from('post-submit')),
      exportStorageState,
      release,
      submit,
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as DouyinPageDriver;
    const storage = {
      getObject: vi.fn(async () => body),
      putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
    } as unknown as ObjectStorageAdapter;
    const encrypt = vi
      .fn()
      .mockResolvedValueOnce({
        credentialCiphertext: 'refreshed-ciphertext',
        credentialKeyVersion: 'local-v2',
      })
      .mockResolvedValueOnce({
        credentialCiphertext: 'after-submit-ciphertext',
        credentialKeyVersion: 'local-v2',
      });
    const service = new DouyinBrowserService(
      config(),
      store,
      driver,
      {
        decrypt: vi.fn(async () => '{}'),
        encrypt,
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
    expect(markSession).toHaveBeenNthCalledWith(
      1,
      session,
      expect.objectContaining({
        error: null,
        status: 'authenticated',
        storageStateCiphertext: 'refreshed-ciphertext',
        storageStateKeyVersion: 'local-v2',
      }),
    );
    expect(markSession).toHaveBeenNthCalledWith(
      2,
      verified,
      expect.objectContaining({
        error: null,
        status: 'authenticated',
        storageStateCiphertext: 'after-submit-ciphertext',
        storageStateKeyVersion: 'local-v2',
      }),
    );
    expect(markSession.mock.calls[0]?.[1]).not.toHaveProperty('authenticatedAt');
    expect(markSession.mock.calls[1]?.[1]).not.toHaveProperty('authenticatedAt');
    expect(exportStorageState.mock.invocationCallOrder[0]).toBeLessThan(
      encrypt.mock.invocationCallOrder[0]!,
    );
    expect(encrypt.mock.invocationCallOrder[0]).toBeLessThan(
      markSession.mock.invocationCallOrder[0]!,
    );
    expect(markSession.mock.invocationCallOrder[0]).toBeLessThan(
      submit.mock.invocationCallOrder[0]!,
    );
    expect(submit.mock.invocationCallOrder[0]).toBeLessThan(
      exportStorageState.mock.invocationCallOrder[1]!,
    );
    expect(exportStorageState.mock.invocationCallOrder[1]).toBeLessThan(
      encrypt.mock.invocationCallOrder[1]!,
    );
    expect(encrypt.mock.invocationCallOrder[1]).toBeLessThan(
      markSession.mock.invocationCallOrder[1]!,
    );
    expect(markSession.mock.invocationCallOrder[1]).toBeLessThan(
      release.mock.invocationCallOrder[0]!,
    );
    expect(exportStorageState).toHaveBeenCalledTimes(2);
    expect(encrypt).toHaveBeenNthCalledWith(2, finalStorageState);
    expect(release).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    expect(store.insertArtifact).toHaveBeenCalledTimes(2);
  });

  it('returns a successful publish result while retaining context when the final snapshot fails', async () => {
    const payload = imageNotePayload();
    const session = browserSession();
    const verified = Object.freeze({ ...session, version: session.version + 1 });
    const published = Object.freeze({
      ...publication('published', 2),
      externalId: 'already-published-note',
    });
    const markSession = vi.fn(async (current: BrowserSession, changes: unknown) => {
      void current;
      void changes;
      return verified;
    });
    const exportStorageState = vi
      .fn()
      .mockResolvedValueOnce('{"cookies":[{"name":"sid","value":"verified"}]}')
      .mockRejectedValueOnce(new Error('final snapshot unavailable'));
    const release = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => session),
        markSession,
        preparePublication: vi.fn(async () => published),
      } as unknown as PostgresDouyinBrowserStore,
      {
        exportStorageState,
        release,
        verifyAuthenticated: vi.fn(async () => true),
      } as unknown as DouyinPageDriver,
      {
        decrypt: vi.fn(async () => '{}'),
        encrypt: vi.fn(async () => ({
          credentialCiphertext: 'verified-ciphertext',
          credentialKeyVersion: 'local-v2',
        })),
      } as unknown as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:final-snapshot-fails',
        payload,
        payload_hash: hashDouyinPayload(payload),
      }),
    ).resolves.toEqual({
      external_id: 'already-published-note',
      status: 'published',
      url: null,
    });
    expect(exportStorageState).toHaveBeenCalledTimes(2);
    expect(markSession).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      'Douyin browser could not persist the final authenticated session snapshot',
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        error: 'Error: final snapshot unavailable',
        stage: 'persist_final_storage_state',
      }),
    );
    warning.mockRestore();
  });

  it('preserves a live CAPTCHA raised after publish authentication succeeds', async () => {
    const payload = imageNotePayload();
    const session = browserSession();
    const verified = Object.freeze({ ...session, version: session.version + 1 });
    const attention = Object.freeze({
      ...verified,
      lastError: { code: 'CAPTCHA_REQUIRED', schema_version: 'douyin-browser-error@1' },
      status: 'attention_required' as const,
      version: verified.version + 1,
    });
    const prepared = publication('prepared', 1);
    const manual = Object.freeze({ ...prepared, status: 'manual_required' as const, version: 2 });
    const body = Buffer.from('card-image');
    const contentHash = createHash('sha256').update(body).digest('hex');
    const markSession = vi.fn().mockResolvedValueOnce(verified).mockResolvedValueOnce(attention);
    const updatePublication = vi.fn(async () => manual);
    const inspectLoginVerification = vi.fn(async () => loginVerificationDiagnostic());
    const release = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
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
        markSession,
        preparePublication: vi.fn(async () => prepared),
        updatePublication,
      } as unknown as PostgresDouyinBrowserStore,
      {
        capture: vi.fn(async () => Buffer.from('captcha-page')),
        exportStorageState: vi.fn(async () => '{"cookies":[]}'),
        inspectLoginVerification,
        release,
        submit: vi.fn(async () => {
          throw new PageDriverError('CAPTCHA_REQUIRED', 'security challenge');
        }),
        verifyAuthenticated: vi.fn(async () => true),
      } as unknown as DouyinPageDriver,
      {
        decrypt: vi.fn(async () => '{}'),
        encrypt: vi.fn(async () => ({
          credentialCiphertext: 'refreshed-ciphertext',
          credentialKeyVersion: 'local-v2',
        })),
      } as unknown as CredentialEnvelopeService,
      {
        getObject: vi.fn(async () => body),
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:submit-captcha',
        payload,
        payload_hash: hashDouyinPayload(payload),
      }),
    ).rejects.toMatchObject({ code: 'CAPTCHA_REQUIRED', statusCode: 423 });
    expect(markSession.mock.calls[1]?.[1]).toMatchObject({
      error: expect.objectContaining({
        code: 'CAPTCHA_REQUIRED',
        verification: expect.objectContaining({ challenge_type: 'identity_choice' }),
      }),
      status: 'attention_required',
    });
    expect(inspectLoginVerification).toHaveBeenCalledOnce();
    expect(updatePublication).toHaveBeenCalledWith(prepared, { status: 'manual_required' });
    expect(release).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('releases an ordinary editor page-signature failure while publishing', async () => {
    const payload = imageNotePayload();
    const session = browserSession();
    const verified = Object.freeze({ ...session, version: session.version + 1 });
    const attention = Object.freeze({
      ...verified,
      lastError: { code: 'PAGE_SIGNATURE_CHANGED', schema_version: 'douyin-browser-error@1' },
      status: 'attention_required' as const,
      version: verified.version + 1,
    });
    const prepared = publication('prepared', 1);
    const manual = Object.freeze({ ...prepared, status: 'manual_required' as const, version: 2 });
    const body = Buffer.from('card-image');
    const contentHash = createHash('sha256').update(body).digest('hex');
    const markSession = vi.fn().mockResolvedValueOnce(verified).mockResolvedValueOnce(attention);
    const updatePublication = vi.fn(async () => manual);
    const inspectLoginVerification = vi.fn(async () => null);
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
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
        markSession,
        preparePublication: vi.fn(async () => prepared),
        updatePublication,
      } as unknown as PostgresDouyinBrowserStore,
      {
        capture: vi.fn(async () => Buffer.from('editor-page')),
        exportStorageState: vi.fn(async () => '{"cookies":[]}'),
        inspectLoginVerification,
        release,
        submit: vi.fn(async () => {
          throw new PageDriverError('PAGE_SIGNATURE_CHANGED', 'publish control changed');
        }),
        verifyAuthenticated: vi.fn(async () => true),
      } as unknown as DouyinPageDriver,
      {
        decrypt: vi.fn(async () => '{}'),
        encrypt: vi.fn(async () => ({
          credentialCiphertext: 'refreshed-ciphertext',
          credentialKeyVersion: 'local-v2',
        })),
      } as unknown as CredentialEnvelopeService,
      {
        getObject: vi.fn(async () => body),
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:submit-page-signature',
        payload,
        payload_hash: hashDouyinPayload(payload),
      }),
    ).rejects.toMatchObject({ code: 'PAGE_SIGNATURE_CHANGED', statusCode: 423 });
    expect(inspectLoginVerification).toHaveBeenCalledWith(ACCOUNT_ID, {
      captureScreenshot: false,
    });
    expect(markSession).toHaveBeenCalledTimes(2);
    expect(markSession.mock.calls[1]?.[1]).toEqual({
      error: { code: 'PAGE_SIGNATURE_CHANGED', schema_version: 'douyin-browser-error@1' },
      status: 'attention_required',
    });
    expect(updatePublication).toHaveBeenCalledWith(prepared, { status: 'manual_required' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('serializes Chromium publishing across different Douyin accounts', async () => {
    const payload = imageNotePayload();
    const body = Buffer.from('card-image');
    const contentHash = createHash('sha256').update(body).digest('hex');
    let activePublishes = 0;
    let maximumActivePublishes = 0;
    const store = {
      getOrCreateSession: vi.fn(async (accountId: string) => ({
        ...browserSession(),
        accountId,
        profileKey: `douyin/${TENANT_ID}/${accountId}`,
      })),
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
      markSession: vi.fn(async (session: BrowserSession) => session),
      preparePublication: vi.fn(async (accountId: string) => ({
        ...publication('prepared', 1),
        accountId,
      })),
      updatePublication: vi.fn(async (current: PublicationRow) => ({
        ...current,
        externalId: `remote-${current.accountId}`,
        status: 'processing' as const,
        version: current.version + 1,
      })),
    } as unknown as PostgresDouyinBrowserStore;
    const submit = vi.fn(async ({ accountId }: { accountId: string }) => {
      activePublishes += 1;
      maximumActivePublishes = Math.max(maximumActivePublishes, activePublishes);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activePublishes -= 1;
      return {
        externalId: `remote-${accountId}`,
        reviewReason: null,
        status: 'processing' as const,
        url: null,
      };
    });
    const service = new DouyinBrowserService(
      config(),
      store,
      {
        capture: vi.fn(async () => Buffer.from('post-submit')),
        exportStorageState: vi.fn(async () => '{"cookies":[]}'),
        release: vi.fn(async () => undefined),
        submit,
        verifyAuthenticated: vi.fn(async () => true),
      } as unknown as DouyinPageDriver,
      {
        decrypt: vi.fn(async () => '{}'),
        encrypt: vi.fn(async () => ({
          credentialCiphertext: 'refreshed-ciphertext',
          credentialKeyVersion: 'local-v2',
        })),
      } as unknown as CredentialEnvelopeService,
      {
        getObject: vi.fn(async () => body),
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );
    const request = (accountId: string) =>
      service.publish(accountId, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: `douyin:image-note:${accountId}`,
        payload,
        payload_hash: hashDouyinPayload(payload),
      });

    await Promise.all([request(ACCOUNT_ID), request(SECOND_ACCOUNT_ID)]);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(maximumActivePublishes).toBe(1);
  });

  it('reopens a crashed page before the pre-publish authentication check', async () => {
    const payload = imageNotePayload();
    const body = Buffer.from('card-image');
    const contentHash = createHash('sha256').update(body).digest('hex');
    const processing = {
      ...publication('processing', 2),
      externalId: 'remote-note-158',
    };
    const store = {
      getOrCreateSession: vi.fn(async () => browserSession()),
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
      markSession: vi.fn(async (session: BrowserSession) => session),
      preparePublication: vi.fn(async () => publication('prepared', 1)),
      updatePublication: vi.fn(async () => processing),
    } as unknown as PostgresDouyinBrowserStore;
    const verifyAuthenticated = vi
      .fn()
      .mockRejectedValueOnce(new Error('locator.count: Target crashed'))
      .mockResolvedValueOnce(true);
    const release = vi.fn(async () => undefined);
    const submit = vi.fn(async () => ({
      externalId: 'remote-note-158',
      reviewReason: null,
      status: 'processing' as const,
      url: null,
    }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new DouyinBrowserService(
      config(),
      store,
      {
        capture: vi.fn(async () => Buffer.from('post-submit')),
        exportStorageState: vi.fn(async () => '{"cookies":[]}'),
        release,
        submit,
        verifyAuthenticated,
      } as unknown as DouyinPageDriver,
      {
        decrypt: vi.fn(async () => '{}'),
        encrypt: vi.fn(async () => ({
          credentialCiphertext: 'refreshed-ciphertext',
          credentialKeyVersion: 'local-v2',
        })),
      } as unknown as CredentialEnvelopeService,
      {
        getObject: vi.fn(async () => body),
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:recover-crashed-page',
        payload,
        payload_hash: hashDouyinPayload(payload),
      }),
    ).resolves.toMatchObject({ external_id: 'remote-note-158', status: 'processing' });
    expect(verifyAuthenticated).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(submit).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it('recovers a persisted browser runtime attention state before scheduled publishing', async () => {
    const payload = imageNotePayload();
    const body = Buffer.from('card-image');
    const contentHash = createHash('sha256').update(body).digest('hex');
    const attention = Object.freeze({
      ...browserSession(),
      lastError: {
        code: 'BROWSER_RUNTIME_FAILED',
        schema_version: 'douyin-browser-error@1',
      },
      status: 'attention_required' as const,
    });
    const authenticated = Object.freeze({
      ...attention,
      lastError: null,
      status: 'authenticated' as const,
      version: attention.version + 1,
    });
    const processing = {
      ...publication('processing', 2),
      externalId: 'remote-note-recovered',
    };
    const markSession = vi.fn(async () => authenticated);
    const store = {
      getOrCreateSession: vi.fn(async () => attention),
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
      markSession,
      preparePublication: vi.fn(async () => publication('prepared', 1)),
      updatePublication: vi.fn(async () => processing),
    } as unknown as PostgresDouyinBrowserStore;
    const verifyAuthenticated = vi
      .fn()
      .mockRejectedValueOnce(new Error('locator.count: Target crashed'))
      .mockResolvedValueOnce(true);
    const release = vi.fn(async () => undefined);
    const submit = vi.fn(async () => ({
      externalId: 'remote-note-recovered',
      reviewReason: null,
      status: 'processing' as const,
      url: null,
    }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new DouyinBrowserService(
      config(),
      store,
      {
        capture: vi.fn(async () => Buffer.from('post-submit')),
        exportStorageState: vi.fn(async () => '{"cookies":[]}'),
        release,
        submit,
        verifyAuthenticated,
      } as unknown as DouyinPageDriver,
      {
        decrypt: vi.fn(async () => '{}'),
        encrypt: vi.fn(async () => ({
          credentialCiphertext: 'refreshed-ciphertext',
          credentialKeyVersion: 'local-v2',
        })),
      } as unknown as CredentialEnvelopeService,
      {
        getObject: vi.fn(async () => body),
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:recover-persisted-runtime-attention',
        payload,
        payload_hash: hashDouyinPayload(payload),
      }),
    ).resolves.toMatchObject({ external_id: 'remote-note-recovered', status: 'processing' });
    expect(verifyAuthenticated).toHaveBeenCalledTimes(2);
    expect(markSession).toHaveBeenCalledWith(
      attention,
      expect.objectContaining({ error: null, status: 'authenticated' }),
    );
    expect(submit).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it('keeps a genuine manual challenge blocked before scheduled publishing', async () => {
    const attention = Object.freeze({
      ...browserSession(),
      lastError: { code: 'CAPTCHA_REQUIRED', schema_version: 'douyin-browser-error@1' },
      status: 'attention_required' as const,
    });
    const verifyAuthenticated = vi.fn();
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => attention),
        markSession: vi.fn(),
      } as unknown as PostgresDouyinBrowserStore,
      { release, verifyAuthenticated } as unknown as DouyinPageDriver,
      { decrypt: vi.fn() } as unknown as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:manual-challenge-remains-blocked',
        payload: imageNotePayload(),
        payload_hash: hashDouyinPayload(imageNotePayload()),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_ATTENTION_REQUIRED', statusCode: 423 });
    expect(verifyAuthenticated).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('keeps an active QR login page open when publishing is blocked', async () => {
    const pending = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      qrExpiresAt: new Date(Date.now() + 60_000),
      status: 'qr_ready' as const,
    });
    const verifyAuthenticated = vi.fn();
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      { getOrCreateSession: vi.fn(async () => pending) } as unknown as PostgresDouyinBrowserStore,
      { release, verifyAuthenticated } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:qr-login-in-progress',
        payload: imageNotePayload(),
        payload_hash: hashDouyinPayload(imageNotePayload()),
      }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED', statusCode: 409 });
    expect(verifyAuthenticated).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('preserves a live CAPTCHA raised by pre-publish authentication', async () => {
    const session = browserSession();
    const attention = Object.freeze({
      ...session,
      lastError: { code: 'CAPTCHA_REQUIRED', schema_version: 'douyin-browser-error@1' },
      status: 'attention_required' as const,
      version: session.version + 1,
    });
    const markSession = vi.fn(async () => attention);
    const preparePublication = vi.fn();
    const release = vi.fn(async () => undefined);
    const diagnostic = loginVerificationDiagnostic();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => session),
        markSession,
        preparePublication,
      } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification: vi.fn(async () => diagnostic),
        release,
        verifyAuthenticated: vi.fn(async () => {
          throw new PageDriverError('CAPTCHA_REQUIRED', 'security challenge');
        }),
      } as unknown as DouyinPageDriver,
      { decrypt: vi.fn(async () => '{}') } as unknown as CredentialEnvelopeService,
      {
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:preflight-captcha',
        payload: imageNotePayload(),
        payload_hash: hashDouyinPayload(imageNotePayload()),
      }),
    ).rejects.toMatchObject({ code: 'CAPTCHA_REQUIRED', statusCode: 423 });
    expect(markSession).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'CAPTCHA_REQUIRED',
          verification: expect.objectContaining({ challenge_type: 'identity_choice' }),
        }),
        status: 'attention_required',
      }),
    );
    expect(preparePublication).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('preserves a confirmed login page-signature challenge during pre-publish authentication', async () => {
    const session = browserSession();
    const attention = Object.freeze({
      ...session,
      lastError: { code: 'PAGE_SIGNATURE_CHANGED', schema_version: 'douyin-browser-error@1' },
      status: 'attention_required' as const,
      version: session.version + 1,
    });
    const diagnostic = loginVerificationDiagnostic();
    const markSession = vi.fn(async () => attention);
    const preparePublication = vi.fn();
    const inspectLoginVerification = vi
      .fn()
      .mockResolvedValueOnce(diagnostic)
      .mockResolvedValueOnce(diagnostic);
    const release = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => session),
        markSession,
        preparePublication,
      } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification,
        release,
        verifyAuthenticated: vi.fn(async () => {
          throw new PageDriverError('PAGE_SIGNATURE_CHANGED', 'login page changed');
        }),
      } as unknown as DouyinPageDriver,
      { decrypt: vi.fn(async () => '{}') } as unknown as CredentialEnvelopeService,
      {
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:preflight-login-page-signature',
        payload: imageNotePayload(),
        payload_hash: hashDouyinPayload(imageNotePayload()),
      }),
    ).rejects.toMatchObject({ code: 'PAGE_SIGNATURE_CHANGED', statusCode: 423 });
    expect(inspectLoginVerification).toHaveBeenNthCalledWith(1, ACCOUNT_ID, {
      captureScreenshot: false,
    });
    expect(inspectLoginVerification).toHaveBeenNthCalledWith(2, ACCOUNT_ID);
    expect(markSession).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'PAGE_SIGNATURE_CHANGED',
          verification: expect.objectContaining({ challenge_type: 'identity_choice' }),
        }),
        status: 'attention_required',
      }),
    );
    expect(preparePublication).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('releases an unconfirmed pre-publish page-signature failure', async () => {
    const session = browserSession();
    const markSession = vi.fn();
    const preparePublication = vi.fn();
    const inspectLoginVerification = vi.fn(async () => null);
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => session),
        markSession,
        preparePublication,
      } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification,
        release,
        verifyAuthenticated: vi.fn(async () => {
          throw new PageDriverError('PAGE_SIGNATURE_CHANGED', 'editor page changed');
        }),
      } as unknown as DouyinPageDriver,
      { decrypt: vi.fn(async () => '{}') } as unknown as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(
      service.publish(ACCOUNT_ID, {
        content_version_id: CONTENT_VERSION_ID,
        idempotency_key: 'douyin:image-note:preflight-editor-page-signature',
        payload: imageNotePayload(),
        payload_hash: hashDouyinPayload(imageNotePayload()),
      }),
    ).rejects.toMatchObject({ code: 'PAGE_SIGNATURE_CHANGED' });
    expect(inspectLoginVerification).toHaveBeenCalledWith(ACCOUNT_ID, {
      captureScreenshot: false,
    });
    expect(markSession).not.toHaveBeenCalled();
    expect(preparePublication).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the browser context after checking an authenticated session', async () => {
    const session = browserSession();
    const verified = Object.freeze({ ...session, version: session.version + 1 });
    const exportStorageState = vi.fn(async () => '{"cookies":[{"name":"sid","value":"fresh"}]}');
    const encrypt = vi.fn(async () => ({
      credentialCiphertext: 'refreshed-ciphertext',
      credentialKeyVersion: 'local-v2',
    }));
    const markSession = vi.fn(async (current: BrowserSession, changes: unknown) => {
      void current;
      void changes;
      return verified;
    });
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getSession: vi.fn(async () => session),
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        exportStorageState,
        release,
        verifyAuthenticated: vi.fn(async () => true),
      } as unknown as DouyinPageDriver,
      { decrypt: vi.fn(async () => '{}'), encrypt } as unknown as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      authenticated_at: session.authenticatedAt?.toISOString(),
      status: 'authenticated',
    });
    expect(encrypt).toHaveBeenCalledWith('{"cookies":[{"name":"sid","value":"fresh"}]}');
    expect(markSession).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        error: null,
        status: 'authenticated',
        storageStateCiphertext: 'refreshed-ciphertext',
        storageStateKeyVersion: 'local-v2',
      }),
    );
    expect(markSession.mock.calls[0]?.[1]).not.toHaveProperty('authenticatedAt');
    expect(exportStorageState.mock.invocationCallOrder[0]).toBeLessThan(
      encrypt.mock.invocationCallOrder[0]!,
    );
    expect(encrypt.mock.invocationCallOrder[0]).toBeLessThan(
      markSession.mock.invocationCallOrder[0]!,
    );
    expect(markSession.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0]!,
    );
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('reopens a crashed page once while polling an authenticated session', async () => {
    const session = browserSession();
    const authenticated = Object.freeze({ ...session, version: session.version + 1 });
    const markSession = vi.fn(async () => authenticated);
    const verifyAuthenticated = vi
      .fn()
      .mockRejectedValueOnce(new Error('locator.count: Target crashed'))
      .mockResolvedValueOnce(true);
    const release = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getSession: vi.fn(async () => session),
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        exportStorageState: vi.fn(async () => '{"cookies":[]}'),
        release,
        verifyAuthenticated,
      } as unknown as DouyinPageDriver,
      {
        decrypt: vi.fn(async () => '{}'),
        encrypt: vi.fn(async () => ({
          credentialCiphertext: 'refreshed-ciphertext',
          credentialKeyVersion: 'local-v2',
        })),
      } as unknown as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      status: 'authenticated',
    });
    expect(verifyAuthenticated).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(markSession).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it('reopens a crashed verification page once and restores an authenticated session', async () => {
    const attention = Object.freeze({
      ...browserSession(),
      status: 'attention_required' as const,
    });
    const authenticated = Object.freeze({
      ...attention,
      status: 'authenticated' as const,
      storageStateCiphertext: 'new-ciphertext',
      storageStateKeyVersion: 'local-v2',
      version: attention.version + 1,
    });
    const markSession = vi.fn(async () => authenticated);
    const inspectLoginVerification = vi
      .fn()
      .mockRejectedValueOnce(new Error('locator.count: Target crashed'))
      .mockResolvedValueOnce(null);
    const verifyAuthenticated = vi.fn(async () => true);
    const release = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getSession: vi.fn(async () => attention),
        markAccountActive: vi.fn(async () => undefined),
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        exportStorageState: vi.fn(async () => '{"cookies":[]}'),
        inspectLoginVerification,
        release,
        verifyAuthenticated,
      } as unknown as DouyinPageDriver,
      {
        decrypt: vi.fn(async () => '{}'),
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
    expect(inspectLoginVerification).toHaveBeenCalledTimes(2);
    expect(verifyAuthenticated).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(2);
    expect(markSession).toHaveBeenCalledWith(
      attention,
      expect.objectContaining({ status: 'authenticated' }),
    );
    warning.mockRestore();
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
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      store,
      {
        release,
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
    expect(release).toHaveBeenCalledOnce();
    failureLog.mockRestore();
  });

  it('releases the browser context when a QR login expires', async () => {
    const initial = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      status: 'login_required' as const,
    });
    const expiresAt = new Date(Date.now() + 60_000);
    const pending = Object.freeze({
      ...initial,
      qrExpiresAt: expiresAt,
      status: 'qr_ready' as const,
      version: 2,
    });
    const expired = Object.freeze({
      ...pending,
      lastError: { code: 'QR_EXPIRED', schema_version: 'douyin-browser-error@1' },
      qrExpiresAt: null,
      status: 'login_required' as const,
      version: 3,
    });
    const markSession = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(expired);
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => initial),
        getSession: vi.fn(async () => pending),
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        release,
        startLogin: vi.fn(async () => ({ expiresAt, qrPng: Buffer.from('qr') })),
        waitForAuthentication: vi.fn(async () => false),
      } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.startLogin(ACCOUNT_ID)).resolves.toMatchObject({ status: 'qr_ready' });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(markSession.mock.calls[1]?.[1]).toMatchObject({
      error: { code: 'QR_EXPIRED' },
      qrExpiresAt: null,
      status: 'login_required',
    });
  });

  it('persists a successful QR login before releasing the browser context', async () => {
    const initial = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      status: 'login_required' as const,
    });
    const expiresAt = new Date(Date.now() + 60_000);
    const pending = Object.freeze({
      ...initial,
      qrExpiresAt: expiresAt,
      status: 'qr_ready' as const,
      version: 2,
    });
    const authenticated = Object.freeze({
      ...pending,
      qrExpiresAt: null,
      status: 'authenticated' as const,
      storageStateCiphertext: 'new-ciphertext',
      storageStateKeyVersion: 'local-v2',
      version: 3,
    });
    const markSession = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(authenticated);
    const exportStorageState = vi.fn(async () => '{"cookies":[]}');
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => initial),
        getSession: vi.fn(async () => pending),
        markAccountActive: vi.fn(async () => undefined),
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        exportStorageState,
        release,
        startLogin: vi.fn(async () => ({ expiresAt, qrPng: Buffer.from('qr') })),
        waitForAuthentication: vi.fn(async () => true),
      } as unknown as DouyinPageDriver,
      {
        encrypt: vi.fn(async () => ({
          credentialCiphertext: 'new-ciphertext',
          credentialKeyVersion: 'local-v2',
        })),
      } as unknown as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.startLogin(ACCOUNT_ID)).resolves.toMatchObject({ status: 'qr_ready' });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(markSession.mock.calls[1]?.[1]).toMatchObject({
      qrExpiresAt: null,
      status: 'authenticated',
      storageStateCiphertext: 'new-ciphertext',
    });
    expect(exportStorageState.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0]!,
    );
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
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => initial),
        getSession: vi.fn(async () => pending),
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification: vi.fn(async () => diagnostic),
        release,
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
    expect(release).not.toHaveBeenCalled();
    diagnosticLog.mockRestore();
    failureLog.mockRestore();
  });

  it('keeps an explicit login page-signature challenge open', async () => {
    const initial = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      status: 'login_required' as const,
    });
    const attention = Object.freeze({
      ...initial,
      lastError: { code: 'PAGE_SIGNATURE_CHANGED', schema_version: 'douyin-browser-error@1' },
      status: 'attention_required' as const,
      version: initial.version + 1,
    });
    const diagnostic = loginVerificationDiagnostic();
    const markSession = vi.fn(async () => attention);
    const inspectLoginVerification = vi.fn(async () => diagnostic);
    const release = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => initial),
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification,
        release,
        startLogin: vi.fn(async () => {
          throw new PageDriverError('PAGE_SIGNATURE_CHANGED', 'login challenge changed');
        }),
      } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      {
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );

    await expect(service.startLogin(ACCOUNT_ID)).rejects.toMatchObject({
      code: 'PAGE_SIGNATURE_CHANGED',
      statusCode: 423,
    });
    expect(inspectLoginVerification).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(markSession).toHaveBeenCalledWith(
      initial,
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'PAGE_SIGNATURE_CHANGED',
          verification: expect.objectContaining({ challenge_type: 'identity_choice' }),
        }),
        status: 'attention_required',
      }),
    );
    expect(release).not.toHaveBeenCalled();
    warning.mockRestore();
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
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => initial),
        getSession,
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        release,
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
    expect(release).not.toHaveBeenCalled();
    attentionLog.mockRestore();
    failureLog.mockRestore();
  });

  it('keeps a pending security challenge recoverable while authentication is incomplete', async () => {
    const attention = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      lastError: {
        code: 'PAGE_SIGNATURE_CHANGED',
        schema_version: 'douyin-browser-error@1',
        verification: { challenge_type: 'unknown' },
      },
      lastVerifiedAt: null,
      status: 'attention_required' as const,
      storageStateCiphertext: null,
      storageStateKeyVersion: null,
    });
    const markSession = vi.fn();
    const markAccountReauth = vi.fn();
    const inspectLoginVerification = vi.fn(async () => unknownLoginVerificationSnapshot());
    const verifyAuthenticated = vi.fn();
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getSession: vi.fn(async () => attention),
        markAccountReauth,
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification,
        release,
        verifyAuthenticated,
      } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      status: 'attention_required',
      verification: {
        challenge_type: 'unknown',
        page_path: '/passport/safe/unknown',
      },
    });
    expect(inspectLoginVerification).toHaveBeenCalledWith(ACCOUNT_ID, {
      captureScreenshot: false,
      includeUnknown: true,
    });
    expect(verifyAuthenticated).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(markSession).not.toHaveBeenCalled();
    expect(markAccountReauth).not.toHaveBeenCalled();
  });

  it('requires a fresh login when the in-memory verification page no longer exists', async () => {
    const attention = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      lastVerifiedAt: null,
      status: 'attention_required' as const,
      storageStateCiphertext: null,
      storageStateKeyVersion: null,
    });
    const reauth = Object.freeze({
      ...attention,
      lastError: { code: 'AUTH_REQUIRED', schema_version: 'douyin-browser-error@1' },
      status: 'reauth' as const,
      version: attention.version + 1,
    });
    const markAccountReauth = vi.fn(async () => undefined);
    const markSession = vi.fn(async () => reauth);
    const verifyAuthenticated = vi.fn();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        getSession: vi.fn(async () => attention),
        markAccountReauth,
        markSession,
      } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification: vi.fn(async () => {
          throw new PageDriverError('AUTH_REQUIRED', 'challenge unavailable');
        }),
        verifyAuthenticated,
      } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({ status: 'reauth' });
    expect(markAccountReauth).toHaveBeenCalledWith(ACCOUNT_ID, TENANT_ID);
    expect(markSession).toHaveBeenCalledWith(
      attention,
      expect.objectContaining({
        error: { code: 'AUTH_REQUIRED', schema_version: 'douyin-browser-error@1' },
        status: 'reauth',
      }),
    );
    expect(verifyAuthenticated).not.toHaveBeenCalled();
    errorLog.mockRestore();
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
    const inspectLoginVerification = vi.fn(async () => diagnostic);
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      { getSession: vi.fn(async () => attention) } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification,
        release,
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
      },
    });
    expect(inspectLoginVerification).toHaveBeenCalledWith(ACCOUNT_ID, {
      captureScreenshot: false,
      includeUnknown: true,
    });
    expect(verifyAuthenticated).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('returns the stored challenge without waiting for an active browser restart', async () => {
    const diagnostic = loginVerificationDiagnostic();
    const contentHash = createHash('sha256').update(diagnostic.screenshotPng).digest('hex');
    const attention = Object.freeze({
      ...browserSession(),
      authenticatedAt: null,
      lastError: {
        code: 'CAPTCHA_REQUIRED',
        verification: {
          available_methods: diagnostic.availableMethods,
          captured_at: diagnostic.capturedAt.toISOString(),
          challenge_type: diagnostic.challengeType,
          content_hash: contentHash,
          has_code_input: diagnostic.hasCodeInput,
          object_uri: 'memory://geo/douyin-browser/redacted.png',
          page_origin: diagnostic.pageOrigin,
          page_path: diagnostic.pagePath,
          page_signature: diagnostic.pageSignature,
        },
      },
      lastVerifiedAt: null,
      status: 'attention_required' as const,
      storageStateCiphertext: null,
      storageStateKeyVersion: null,
    });
    const pending = Object.freeze({
      ...attention,
      lastError: null,
      qrExpiresAt: new Date(Date.now() + 60_000),
      status: 'qr_ready' as const,
      version: 2,
    });
    let finishBrowserStart: (
      value: Readonly<{ expiresAt: Date; qrPng: Uint8Array }>,
    ) => void = () => undefined;
    const browserStart = new Promise<Readonly<{ expiresAt: Date; qrPng: Uint8Array }>>(
      (resolve) => {
        finishBrowserStart = resolve;
      },
    );
    const release = vi.fn(async () => undefined);
    const startLogin = vi.fn(async () => browserStart);
    const inspectLoginVerification = vi.fn();
    const getObject = vi.fn(async () => diagnostic.screenshotPng);
    const service = new DouyinBrowserService(
      config(),
      {
        getOrCreateSession: vi.fn(async () => attention),
        getSession: vi.fn(async () => attention),
        markSession: vi.fn(async () => pending),
      } as unknown as PostgresDouyinBrowserStore,
      {
        inspectLoginVerification,
        release,
        startLogin,
        waitForAuthentication: vi.fn(() => new Promise<boolean>(() => undefined)),
      } as unknown as DouyinPageDriver,
      {} as CredentialEnvelopeService,
      { getObject } as unknown as ObjectStorageAdapter,
    );

    const restart = service.startLogin(ACCOUNT_ID);
    await vi.waitFor(() => expect(startLogin).toHaveBeenCalledOnce());
    await expect(service.sessionStatus(ACCOUNT_ID)).resolves.toMatchObject({
      status: 'attention_required',
      verification: {
        available_methods: ['sms_code', 'original_device_scan'],
        challenge_type: 'identity_choice',
      },
    });
    expect(release).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(inspectLoginVerification).not.toHaveBeenCalled();
    expect(getObject).not.toHaveBeenCalled();

    finishBrowserStart({ expiresAt: pending.qrExpiresAt!, qrPng: Buffer.from('replacement-qr') });
    await expect(restart).resolves.toMatchObject({ status: 'qr_ready' });
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
    const release = vi.fn(async () => undefined);
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
        release,
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
    expect(release).toHaveBeenCalledOnce();
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
    const release = vi.fn(async () => undefined);
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
        release,
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
    expect(release).toHaveBeenCalledOnce();
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
      markSession: vi.fn(async () => session),
      preparePublication: vi.fn(async () => unresolved),
      updatePublication,
    } as unknown as PostgresDouyinBrowserStore;
    const driver = {
      capture: vi.fn(async () => Buffer.from('unresolved-state')),
      exportStorageState: vi.fn(async () => '{"cookies":[]}'),
      reconcile: vi.fn(async () => null),
      release: vi.fn(async () => undefined),
      submit: vi.fn(),
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as DouyinPageDriver;
    const service = new DouyinBrowserService(
      config(),
      store,
      driver,
      {
        decrypt: vi.fn(async () => '{}'),
        encrypt: vi.fn(async () => ({
          credentialCiphertext: 'refreshed-ciphertext',
          credentialKeyVersion: 'local-v2',
        })),
      } as unknown as CredentialEnvelopeService,
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
    const session = browserSession();
    const verified = Object.freeze({ ...session, version: session.version + 1 });
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
    const markSession = vi.fn(async (current: BrowserSession, changes: unknown) => {
      void current;
      void changes;
      return verified;
    });
    const store = {
      findPublication: vi.fn(async () => manual),
      getSession: vi.fn(async () => session),
      insertArtifact: vi.fn(async () => undefined),
      markSession,
      updatePublication,
    } as unknown as PostgresDouyinBrowserStore;
    const reconcile = vi.fn(async () => remote);
    const exportStorageState = vi.fn(
      async () => '{"cookies":[{"name":"sid","value":"after-reconcile"}]}',
    );
    const encrypt = vi.fn(async () => ({
      credentialCiphertext: 'after-reconcile-ciphertext',
      credentialKeyVersion: 'local-v2',
    }));
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      store,
      {
        capture: vi.fn(async () => Buffer.from('reconciled-publication')),
        exportStorageState,
        reconcile,
        release,
      } as unknown as DouyinPageDriver,
      { decrypt: vi.fn(async () => '{}'), encrypt } as unknown as CredentialEnvelopeService,
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
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      exportStorageState.mock.invocationCallOrder[0]!,
    );
    expect(exportStorageState.mock.invocationCallOrder[0]).toBeLessThan(
      encrypt.mock.invocationCallOrder[0]!,
    );
    expect(encrypt.mock.invocationCallOrder[0]).toBeLessThan(
      markSession.mock.invocationCallOrder[0]!,
    );
    expect(markSession).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        error: null,
        status: 'authenticated',
        storageStateCiphertext: 'after-reconcile-ciphertext',
      }),
    );
    expect(markSession.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0]!,
    );
    expect(release).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('returns and stores a reconciled result while retaining context when its final snapshot fails', async () => {
    const fingerprint = 'a'.repeat(64);
    const session = browserSession();
    const processing = Object.freeze({
      ...publication('processing', 3),
      externalId: fingerprint,
    });
    const remote = Object.freeze({
      externalId: '7678487251839470902',
      reviewReason: null,
      status: 'published' as const,
      url: 'https://www.douyin.com/note/7678487251839470902',
    });
    const published = Object.freeze({
      ...processing,
      externalId: remote.externalId,
      externalUrl: remote.url,
      status: 'published' as const,
      version: processing.version + 1,
    });
    const updatePublication = vi.fn(async () => published);
    const markSession = vi.fn();
    const release = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        findPublication: vi.fn(async () => processing),
        getSession: vi.fn(async () => session),
        insertArtifact: vi.fn(async () => undefined),
        markSession,
        updatePublication,
      } as unknown as PostgresDouyinBrowserStore,
      {
        capture: vi.fn(async () => Buffer.from('reconciled-publication')),
        exportStorageState: vi.fn(async () => {
          throw new Error('final snapshot unavailable');
        }),
        reconcile: vi.fn(async () => remote),
        release,
      } as unknown as DouyinPageDriver,
      {
        decrypt: vi.fn(async () => '{}'),
        encrypt: vi.fn(),
      } as unknown as CredentialEnvelopeService,
      {
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );

    await expect(service.status(ACCOUNT_ID, fingerprint)).resolves.toEqual({
      external_id: remote.externalId,
      status: 'published',
      url: remote.url,
    });
    expect(updatePublication).toHaveBeenCalledWith(processing, {
      remote,
      status: 'published',
    });
    expect(markSession).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      'Douyin browser could not persist the final authenticated session snapshot',
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        error: 'Error: final snapshot unavailable',
        stage: 'persist_final_storage_state',
      }),
    );
    warning.mockRestore();
  });

  it('preserves manual-required state when authenticated reconciliation finds no match', async () => {
    const fingerprint = 'a'.repeat(64);
    const session = browserSession();
    const manual = Object.freeze({
      ...publication('manual_required', 3),
      externalId: fingerprint,
    });
    const updatePublication = vi.fn();
    const reconcile = vi.fn(async () => null);
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        findPublication: vi.fn(async () => manual),
        getSession: vi.fn(async () => session),
        markSession: vi.fn(async () => session),
        updatePublication,
      } as unknown as PostgresDouyinBrowserStore,
      {
        exportStorageState: vi.fn(async () => '{"cookies":[]}'),
        reconcile,
        release,
      } as unknown as DouyinPageDriver,
      {
        decrypt: vi.fn(async () => '{}'),
        encrypt: vi.fn(async () => ({
          credentialCiphertext: 'after-reconcile-ciphertext',
          credentialKeyVersion: 'local-v2',
        })),
      } as unknown as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    await expect(service.status(ACCOUNT_ID, fingerprint)).resolves.toEqual({
      external_id: fingerprint,
      status: 'unknown',
      url: null,
    });
    expect(updatePublication).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('preserves a live CAPTCHA raised while reconciling publication status', async () => {
    const session = browserSession();
    const processing = Object.freeze({
      ...publication('processing', 2),
      externalId: 'pending-note',
    });
    const manual = Object.freeze({ ...processing, status: 'manual_required' as const, version: 3 });
    const markSession = vi.fn(async () => ({
      ...session,
      status: 'attention_required' as const,
      version: session.version + 1,
    }));
    const updatePublication = vi.fn(async () => manual);
    const release = vi.fn(async () => undefined);
    const inspectLoginVerification = vi.fn(async () => loginVerificationDiagnostic());
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        findPublication: vi.fn(async () => processing),
        getSession: vi.fn(async () => session),
        insertArtifact: vi.fn(async () => undefined),
        markSession,
        updatePublication,
      } as unknown as PostgresDouyinBrowserStore,
      {
        capture: vi.fn(async () => Buffer.from('captcha-page')),
        inspectLoginVerification,
        reconcile: vi.fn(async () => {
          throw new PageDriverError('CAPTCHA_REQUIRED', 'security challenge');
        }),
        release,
      } as unknown as DouyinPageDriver,
      { decrypt: vi.fn(async () => '{}') } as unknown as CredentialEnvelopeService,
      {
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );

    await expect(service.status(ACCOUNT_ID, 'pending-note')).rejects.toMatchObject({
      code: 'CAPTCHA_REQUIRED',
      statusCode: 423,
    });
    expect(markSession).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'CAPTCHA_REQUIRED',
          verification: expect.objectContaining({ challenge_type: 'identity_choice' }),
        }),
        status: 'attention_required',
      }),
    );
    expect(inspectLoginVerification).toHaveBeenCalledOnce();
    expect(updatePublication).toHaveBeenCalledWith(processing, { status: 'manual_required' });
    expect(release).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('releases an ordinary manage-page signature failure while reconciling status', async () => {
    const session = browserSession();
    const processing = Object.freeze({
      ...publication('processing', 2),
      externalId: 'pending-note',
    });
    const manual = Object.freeze({ ...processing, status: 'manual_required' as const, version: 3 });
    const markSession = vi.fn(async () => ({
      ...session,
      status: 'attention_required' as const,
      version: session.version + 1,
    }));
    const updatePublication = vi.fn(async () => manual);
    const inspectLoginVerification = vi.fn(async () => null);
    const release = vi.fn(async () => undefined);
    const service = new DouyinBrowserService(
      config(),
      {
        findPublication: vi.fn(async () => processing),
        getSession: vi.fn(async () => session),
        insertArtifact: vi.fn(async () => undefined),
        markSession,
        updatePublication,
      } as unknown as PostgresDouyinBrowserStore,
      {
        capture: vi.fn(async () => Buffer.from('manage-page')),
        inspectLoginVerification,
        reconcile: vi.fn(async () => {
          throw new PageDriverError('PAGE_SIGNATURE_CHANGED', 'manage page changed');
        }),
        release,
      } as unknown as DouyinPageDriver,
      { decrypt: vi.fn(async () => '{}') } as unknown as CredentialEnvelopeService,
      {
        putObject: vi.fn(async ({ key }: { key: string }) => ({ uri: `memory://geo/${key}` })),
      } as unknown as ObjectStorageAdapter,
    );

    await expect(service.status(ACCOUNT_ID, 'pending-note')).rejects.toMatchObject({
      code: 'PAGE_SIGNATURE_CHANGED',
      statusCode: 423,
    });
    expect(inspectLoginVerification).toHaveBeenCalledWith(ACCOUNT_ID, {
      captureScreenshot: false,
    });
    expect(markSession).toHaveBeenCalledWith(session, {
      error: { code: 'PAGE_SIGNATURE_CHANGED', schema_version: 'douyin-browser-error@1' },
      status: 'attention_required',
    });
    expect(updatePublication).toHaveBeenCalledWith(processing, { status: 'manual_required' });
    expect(release).toHaveBeenCalledOnce();
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

  it.each(['qr_ready', 'attention_required'] as const)(
    'does not use the browser to reconcile a %s session',
    async (status) => {
      const verifyAuthenticated = vi.fn();
      const reconcile = vi.fn();
      const release = vi.fn(async () => undefined);
      const service = new DouyinBrowserService(
        config(),
        {
          findPublication: vi.fn(async () => publication('processing', 2)),
          getSession: vi.fn(async () => ({ ...browserSession(), status })),
        } as unknown as PostgresDouyinBrowserStore,
        {
          reconcile,
          release,
          verifyAuthenticated,
        } as unknown as DouyinPageDriver,
        {} as CredentialEnvelopeService,
        {} as ObjectStorageAdapter,
      );

      await expect(service.status(ACCOUNT_ID, 'pending-note')).resolves.toMatchObject({
        status: 'unknown',
      });
      expect(verifyAuthenticated).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    },
  );

  it('does not enter submitting when frozen image validation fails', async () => {
    const payload = imageNotePayload();
    const prepared = publication('prepared', 1);
    const store = {
      getOrCreateSession: vi.fn(async () => browserSession()),
      loadImageAssets: vi.fn(async () => {
        throw new Error('object storage unavailable');
      }),
      markSession: vi.fn(async () => browserSession()),
      preparePublication: vi.fn(async () => prepared),
      updatePublication: vi.fn(),
    } as unknown as PostgresDouyinBrowserStore;
    const driver = {
      exportStorageState: vi.fn(async () => '{"cookies":[]}'),
      release: vi.fn(async () => undefined),
      submit: vi.fn(),
      verifyAuthenticated: vi.fn(async () => true),
    } as unknown as DouyinPageDriver;
    const service = new DouyinBrowserService(
      config(),
      store,
      driver,
      {
        decrypt: vi.fn(async () => '{}'),
        encrypt: vi.fn(async () => ({
          credentialCiphertext: 'refreshed-ciphertext',
          credentialKeyVersion: 'local-v2',
        })),
      } as unknown as CredentialEnvelopeService,
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

function unknownLoginVerificationSnapshot(): LoginVerificationSnapshot {
  return Object.freeze({
    availableMethods: Object.freeze([]),
    capturedAt: new Date('2026-08-28T07:36:24.000Z'),
    challengeType: 'unknown',
    controlEvidence: Object.freeze({
      codeInputActionable: false,
      codeInputEditable: false,
      codeInputEnabled: false,
      codeInputHitTarget: false,
      codeInputStepActionable: false,
      codeInputVisible: false,
      faceVerificationOptionVisible: false,
      foregroundDialogVisible: false,
      originalDeviceOptionVisible: false,
      receiveSmsOptionVisible: false,
      sendSmsOptionVisible: false,
      submitControlActionable: false,
      submitControlEnabled: false,
      submitControlHitTarget: false,
      submitControlVisible: false,
      visualCaptchaVisible: false,
    }),
    hasCodeInput: false,
    pageOrigin: 'https://creator.douyin.com',
    pagePath: '/passport/safe/unknown',
    pageSignature: 'b'.repeat(64),
    qrPng: null,
    smsResendAvailable: false,
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
