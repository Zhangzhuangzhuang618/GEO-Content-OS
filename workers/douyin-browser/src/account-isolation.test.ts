import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import type { CredentialEnvelopeService } from '@geo-content-os/security/credentials';
import { describe, expect, it, vi } from 'vitest';

import type { DouyinBrowserConfig } from './config.js';
import { DouyinBrowserService } from './service.js';
import type { PostgresDouyinBrowserStore } from './store.js';
import type { BrowserSession, DouyinPageDriver } from './types.js';

const FIRST_ACCOUNT_ID = '00000000-0000-4000-8000-000000000158';
const SECOND_ACCOUNT_ID = '00000000-0000-4000-8000-000000000258';
const FIRST_SESSION_ID = '00000000-0000-4000-8000-000000000161';
const SECOND_SESSION_ID = '00000000-0000-4000-8000-000000000261';
const TENANT_ID = '00000000-0000-4000-8000-000000000162';

describe('Douyin multi-account login isolation', () => {
  it('keeps overlapping QR attempts, profiles and encrypted snapshots scoped to each account', async () => {
    const sessions = new Map<string, BrowserSession>([
      [FIRST_ACCOUNT_ID, loginRequiredSession(FIRST_ACCOUNT_ID, FIRST_SESSION_ID)],
      [SECOND_ACCOUNT_ID, loginRequiredSession(SECOND_ACCOUNT_ID, SECOND_SESSION_ID)],
    ]);
    const authentication = new Map([
      [FIRST_ACCOUNT_ID, deferred<boolean>()],
      [SECOND_ACCOUNT_ID, deferred<boolean>()],
    ]);
    const firstExpiry = new Date('2099-09-04T00:01:00.000Z');
    const secondExpiry = new Date('2099-09-04T00:02:00.000Z');
    const expiryByAccount = new Map([
      [FIRST_ACCOUNT_ID, firstExpiry],
      [SECOND_ACCOUNT_ID, secondExpiry],
    ]);
    const markSession = vi.fn(async (session: BrowserSession, input: SessionUpdate) => {
      const current = sessions.get(session.accountId);
      if (!current || current.version !== session.version) {
        throw new Error(`stale session for ${session.accountId}`);
      }
      const updated = Object.freeze({
        ...session,
        authenticatedAt:
          input.authenticatedAt === undefined ? session.authenticatedAt : input.authenticatedAt,
        lastError: input.error === undefined ? null : input.error,
        lastVerifiedAt:
          input.lastVerifiedAt === undefined ? session.lastVerifiedAt : input.lastVerifiedAt,
        qrExpiresAt: input.qrExpiresAt === undefined ? session.qrExpiresAt : input.qrExpiresAt,
        status: input.status,
        storageStateCiphertext:
          input.storageStateCiphertext === undefined
            ? session.storageStateCiphertext
            : input.storageStateCiphertext,
        storageStateKeyVersion:
          input.storageStateKeyVersion === undefined
            ? session.storageStateKeyVersion
            : input.storageStateKeyVersion,
        version: session.version + 1,
      }) satisfies BrowserSession;
      sessions.set(session.accountId, updated);
      return updated;
    });
    const markAccountActive = vi.fn(async () => undefined);
    const store = {
      getOrCreateSession: vi.fn(async (accountId: string) => requireSession(sessions, accountId)),
      getSession: vi.fn(async (accountId: string) => requireSession(sessions, accountId)),
      markAccountActive,
      markSession,
    } as unknown as PostgresDouyinBrowserStore;
    const startLogin = vi.fn(async (accountId: string) => ({
      expiresAt: requireValue(expiryByAccount, accountId),
      qrPng: Buffer.from(`qr:${accountId}`),
    }));
    const exportStorageState = vi.fn(async (accountId: string) =>
      JSON.stringify({ account_id: accountId }),
    );
    const release = vi.fn(async () => undefined);
    const waitForAuthentication = vi.fn(
      (accountId: string) => requireValue(authentication, accountId).promise,
    );
    const driver = {
      close: vi.fn(async () => undefined),
      exportStorageState,
      release,
      startLogin,
      waitForAuthentication,
    } as unknown as DouyinPageDriver;
    const encrypt = vi.fn(async (storageStateJson: string) => {
      const state = JSON.parse(storageStateJson) as { readonly account_id: string };
      return {
        credentialCiphertext: `ciphertext:${state.account_id}`,
        credentialKeyVersion:
          state.account_id === FIRST_ACCOUNT_ID ? 'account-one-v1' : 'account-two-v1',
      };
    });
    const service = new DouyinBrowserService(
      config(),
      store,
      driver,
      { encrypt } as unknown as CredentialEnvelopeService,
      {} as ObjectStorageAdapter,
    );

    const [firstLogin, secondLogin] = await Promise.all([
      service.startLogin(FIRST_ACCOUNT_ID),
      service.startLogin(SECOND_ACCOUNT_ID),
    ]);

    expect(firstLogin).toMatchObject({
      account_id: FIRST_ACCOUNT_ID,
      qr_expires_at: firstExpiry.toISOString(),
      qr_image_data_url: `data:image/png;base64,${Buffer.from(`qr:${FIRST_ACCOUNT_ID}`).toString('base64')}`,
      status: 'qr_ready',
    });
    expect(secondLogin).toMatchObject({
      account_id: SECOND_ACCOUNT_ID,
      qr_expires_at: secondExpiry.toISOString(),
      qr_image_data_url: `data:image/png;base64,${Buffer.from(`qr:${SECOND_ACCOUNT_ID}`).toString('base64')}`,
      status: 'qr_ready',
    });
    expect(startLogin).toHaveBeenCalledWith(
      FIRST_ACCOUNT_ID,
      `/tmp/douyin-account-isolation/douyin/${TENANT_ID}/${FIRST_ACCOUNT_ID}`,
    );
    expect(startLogin).toHaveBeenCalledWith(
      SECOND_ACCOUNT_ID,
      `/tmp/douyin-account-isolation/douyin/${TENANT_ID}/${SECOND_ACCOUNT_ID}`,
    );
    expect(waitForAuthentication).toHaveBeenCalledWith(FIRST_ACCOUNT_ID, firstExpiry);
    expect(waitForAuthentication).toHaveBeenCalledWith(SECOND_ACCOUNT_ID, secondExpiry);

    requireValue(authentication, FIRST_ACCOUNT_ID).resolve(true);
    await vi.waitFor(() => {
      expect(requireSession(sessions, FIRST_ACCOUNT_ID).status).toBe('authenticated');
    });
    expect(requireSession(sessions, FIRST_ACCOUNT_ID)).toMatchObject({
      accountId: FIRST_ACCOUNT_ID,
      status: 'authenticated',
      storageStateCiphertext: `ciphertext:${FIRST_ACCOUNT_ID}`,
      storageStateKeyVersion: 'account-one-v1',
    });
    expect(requireSession(sessions, SECOND_ACCOUNT_ID)).toMatchObject({
      accountId: SECOND_ACCOUNT_ID,
      status: 'qr_ready',
      storageStateCiphertext: null,
      storageStateKeyVersion: null,
    });
    expect(release).toHaveBeenCalledWith(FIRST_ACCOUNT_ID);
    expect(release).not.toHaveBeenCalledWith(SECOND_ACCOUNT_ID);

    requireValue(authentication, SECOND_ACCOUNT_ID).resolve(true);
    await vi.waitFor(() => {
      expect(requireSession(sessions, SECOND_ACCOUNT_ID).status).toBe('authenticated');
    });
    expect(requireSession(sessions, SECOND_ACCOUNT_ID)).toMatchObject({
      accountId: SECOND_ACCOUNT_ID,
      status: 'authenticated',
      storageStateCiphertext: `ciphertext:${SECOND_ACCOUNT_ID}`,
      storageStateKeyVersion: 'account-two-v1',
    });
    expect(exportStorageState.mock.calls).toEqual([[FIRST_ACCOUNT_ID], [SECOND_ACCOUNT_ID]]);
    expect(encrypt.mock.calls).toEqual([
      [JSON.stringify({ account_id: FIRST_ACCOUNT_ID })],
      [JSON.stringify({ account_id: SECOND_ACCOUNT_ID })],
    ]);
    expect(markAccountActive.mock.calls).toEqual([
      [FIRST_ACCOUNT_ID, TENANT_ID],
      [SECOND_ACCOUNT_ID, TENANT_ID],
    ]);
    expect(release.mock.calls).toEqual([[FIRST_ACCOUNT_ID], [SECOND_ACCOUNT_ID]]);
  });
});

interface SessionUpdate {
  readonly authenticatedAt?: Date | null;
  readonly error?: Readonly<Record<string, unknown>> | null;
  readonly lastVerifiedAt?: Date | null;
  readonly qrExpiresAt?: Date | null;
  readonly status: BrowserSession['status'];
  readonly storageStateCiphertext?: string | null;
  readonly storageStateKeyVersion?: string | null;
}

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
    profileRoot: '/tmp/douyin-account-isolation',
    simulator: false,
  });
}

function loginRequiredSession(accountId: string, sessionId: string): BrowserSession {
  return Object.freeze({
    accountId,
    authenticatedAt: null,
    id: sessionId,
    lastError: null,
    lastVerifiedAt: null,
    profileKey: `douyin/${TENANT_ID}/${accountId}`,
    qrExpiresAt: null,
    status: 'login_required',
    storageStateCiphertext: null,
    storageStateKeyVersion: null,
    tenantId: TENANT_ID,
    version: 1,
  });
}

function requireSession(sessions: ReadonlyMap<string, BrowserSession>, accountId: string) {
  const session = sessions.get(accountId);
  if (!session) throw new Error(`missing session for ${accountId}`);
  return session;
}

function requireValue<T>(values: ReadonlyMap<string, T>, key: string): T {
  const value = values.get(key);
  if (!value) throw new Error(`missing value for ${key}`);
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
