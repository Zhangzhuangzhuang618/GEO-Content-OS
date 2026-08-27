import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve, sep } from 'node:path';

import {
  DouyinDeliveryInputSchema,
  hashDouyinPayload,
} from '@geo-content-os/adapter-platforms/douyin/delivery';
import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import {
  CredentialEnvelopeError,
  type CredentialEnvelopeService,
} from '@geo-content-os/security/credentials';

import { AccountLock } from './account-lock.js';
import type { DouyinBrowserConfig } from './config.js';
import { PageDriverError, PageDriverOperationError } from './page-driver.js';
import { BrowserStoreError, type PostgresDouyinBrowserStore } from './store.js';
import type {
  BrowserImage,
  BrowserPublishInput,
  BrowserSession,
  DouyinPageDriver,
  PublicationClaim,
  RemotePublication,
} from './types.js';

const UNKNOWN_RECONCILIATION_GRACE_MS = 2 * 60_000;

export class BrowserGatewayError extends Error {
  public constructor(
    public readonly statusCode: 400 | 401 | 404 | 409 | 423 | 503,
    public readonly code: string,
    message: string,
    public readonly stage?: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BrowserGatewayError';
  }
}

export class DouyinBrowserService {
  private readonly locks = new AccountLock();

  public constructor(
    private readonly config: DouyinBrowserConfig,
    private readonly store: PostgresDouyinBrowserStore,
    private readonly driver: DouyinPageDriver,
    private readonly credentials: CredentialEnvelopeService,
    private readonly storage: ObjectStorageAdapter,
  ) {}

  public authenticate(value: string | undefined): void {
    const expected = Buffer.from(this.config.gatewayToken, 'utf8');
    const actual = Buffer.from(value?.replace(/^Bearer\s+/iu, '') ?? '', 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new BrowserGatewayError(401, 'UNAUTHORIZED', 'Gateway authorization failed');
    }
  }

  public capabilities(): Readonly<Record<string, boolean>> {
    return Object.freeze({ get_status: true, metrics: false, publish: true });
  }

  public async startLogin(accountId: string): Promise<Readonly<Record<string, unknown>>> {
    return this.locks.run(accountId, async () => {
      const session = await this.store.getOrCreateSession(accountId);
      try {
        const result = await this.driver.startLogin(accountId, this.profilePath(session));
        if (result.qrPng.byteLength === 0) {
          return sessionView(await this.persistAuthenticatedSession(session));
        }
        const pending = await this.store.markSession(session, {
          error: null,
          qrExpiresAt: result.expiresAt,
          status: 'qr_ready',
        });
        void this.finishLogin(pending, result.expiresAt);
        return Object.freeze({
          ...sessionView(pending),
          qr_image_data_url: `data:image/png;base64,${Buffer.from(result.qrPng).toString('base64')}`,
        });
      } catch (error) {
        if (error instanceof PageDriverError) {
          const status =
            error.code === 'CAPTCHA_REQUIRED' || error.code === 'PAGE_SIGNATURE_CHANGED'
              ? 'attention_required'
              : session.status;
          await this.store.markSession(session, {
            error: { code: error.code, schema_version: 'douyin-browser-error@1' },
            qrExpiresAt: null,
            status,
          });
          throw new BrowserGatewayError(423, error.code, error.message);
        }
        throw error;
      }
    });
  }

  public async reauthenticate(accountId: string): Promise<Readonly<Record<string, unknown>>> {
    return this.startLogin(accountId);
  }

  public async sessionStatus(accountId: string): Promise<Readonly<Record<string, unknown>>> {
    const session = await this.store.getSession(accountId);
    if (!canVerifySession(session)) return sessionView(session);
    return this.locks.run(accountId, async () => {
      const current = await this.store.getSession(accountId);
      if (!canVerifySession(current)) return sessionView(current);
      try {
        const authenticated = await this.driver.verifyAuthenticated(
          accountId,
          this.profilePath(current),
          await this.decryptState(current),
        );
        if (!authenticated) {
          return current.status === 'attention_required'
            ? sessionView(current)
            : sessionView(await this.requireReauth(current, 'LOGIN_EXPIRED'));
        }
        if (current.status === 'attention_required') {
          return sessionView(await this.persistAuthenticatedSession(current));
        }
        return sessionView(
          await this.store.markSession(current, {
            error: null,
            lastVerifiedAt: new Date(),
            status: 'authenticated',
          }),
        );
      } catch (error) {
        const code = sessionVerificationErrorCode(error);
        console.error('Douyin browser session verification failed', {
          account_id: accountId,
          error: safeBrowserError(error),
          error_code: code,
        });
        if (
          error instanceof CredentialEnvelopeError ||
          (error instanceof PageDriverError && error.code === 'AUTH_REQUIRED')
        ) {
          return sessionView(await this.requireReauth(current, code));
        }
        return sessionView(
          await this.store.markSession(current, {
            error: { code, schema_version: 'douyin-browser-error@1' },
            status: 'attention_required',
          }),
        );
      }
    });
  }

  public async publish(
    accountId: string,
    raw: unknown,
  ): Promise<{
    readonly external_id: string;
    readonly status: 'processing' | 'published';
    readonly url: string | null;
  }> {
    const parsed = DouyinDeliveryInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BrowserGatewayError(400, 'SCHEMA_INVALID', 'Douyin publish payload is invalid');
    }
    if (parsed.data.payload.schema_version !== 'douyin-image-note-payload@1') {
      throw new BrowserGatewayError(
        409,
        'CONTENT_KIND_UNSUPPORTED',
        'Managed Douyin publishing only accepts image-note payloads',
      );
    }
    if (hashDouyinPayload(parsed.data.payload) !== parsed.data.payload_hash) {
      throw new BrowserGatewayError(
        409,
        'PAYLOAD_HASH_MISMATCH',
        'Frozen Douyin payload hash does not match',
      );
    }
    const input: BrowserPublishInput = Object.freeze({
      contentVersionId: parsed.data.content_version_id,
      idempotencyKey: parsed.data.idempotency_key,
      payload: parsed.data.payload,
      payloadHash: parsed.data.payload_hash,
    });
    return this.locks.run(accountId, () => this.publishLocked(accountId, input));
  }

  public async status(
    accountId: string,
    externalId: string,
  ): Promise<{
    readonly external_id: string;
    readonly status: RemotePublication['status'];
    readonly url: string | null;
  }> {
    return this.locks.run(accountId, async () => {
      const publication = await this.store.findPublication(accountId, externalId);
      if (publication.status === 'published' || publication.status === 'failed') {
        return responseStatus(publication, publication.status);
      }
      const session = await this.store.getSession(accountId);
      if (publication.status === 'manual_required' && session.status !== 'authenticated') {
        return responseStatus(publication, 'unknown');
      }
      const remote = await this.reconcile(session, publication);
      if (!remote) return responseStatus(publication, 'unknown');
      const updated = await this.store.updatePublication(publication, {
        remote,
        status: publicationStatus(remote.status),
      });
      return responseStatus(updated, remote.status);
    });
  }

  public async metrics(
    accountId: string,
    externalId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const status = await this.status(accountId, externalId);
    return Object.freeze({
      external_id: status.external_id,
      measured_at: new Date().toISOString(),
      metrics: {},
    });
  }

  public close(): Promise<void> {
    return this.driver.close();
  }

  private async publishLocked(
    accountId: string,
    input: BrowserPublishInput,
  ): Promise<{
    readonly external_id: string;
    readonly status: 'processing' | 'published';
    readonly url: string | null;
  }> {
    let session = await this.store.getOrCreateSession(accountId);
    if (session.status === 'attention_required') {
      throw new BrowserGatewayError(
        423,
        'SESSION_ATTENTION_REQUIRED',
        'Douyin browser automation is paused for manual attention',
      );
    }
    if (session.status !== 'authenticated') {
      throw new BrowserGatewayError(409, 'AUTH_REQUIRED', 'Douyin browser login is required');
    }
    const storageStateJson = await this.decryptState(session);
    if (
      !(await this.driver.verifyAuthenticated(
        accountId,
        this.profilePath(session),
        storageStateJson,
      ))
    ) {
      session = await this.requireReauth(session, 'LOGIN_EXPIRED');
      void session;
      throw new BrowserGatewayError(409, 'AUTH_REQUIRED', 'Douyin browser login has expired');
    }

    const contentFingerprint = sha256(
      `${input.payload.title}\n${normalizeText(input.payload.description)}\n${input.payload.image_asset_ids.join(',')}`,
    );
    let publication = await this.store.preparePublication(accountId, input, contentFingerprint);
    if (publication.status === 'published') return publishResponse(publication, 'published');
    if (publication.status === 'failed' || publication.status === 'manual_required') {
      throw new BrowserGatewayError(
        409,
        'PUBLICATION_TERMINAL',
        'Douyin publication requires manual handling',
      );
    }
    if (publication.status !== 'prepared') {
      const remote = await this.reconcile(session, publication);
      if (remote) {
        const updated = await this.store.updatePublication(publication, {
          remote,
          status: publicationStatus(remote.status),
        });
        if (remote.status === 'failed') {
          throw new BrowserGatewayError(409, 'PUBLISH_REJECTED', 'Douyin rejected publication');
        }
        return publishResponse(updated, remote.status === 'published' ? 'published' : 'processing');
      }
      if (
        !publication.submittedAt ||
        Date.now() - publication.submittedAt.getTime() < UNKNOWN_RECONCILIATION_GRACE_MS
      ) {
        throw new BrowserGatewayError(
          503,
          'PUBLISH_STATE_UNKNOWN',
          'Douyin publication is not yet visible; reconcile before retrying',
        );
      }
      const unresolved = await this.store.updatePublication(publication, {
        status: 'manual_required',
      });
      await this.captureAttention(unresolved).catch(() => undefined);
      throw new BrowserGatewayError(
        423,
        'PUBLISH_STATE_UNKNOWN',
        'Douyin publication could not be reconciled; confirm the remote result before retrying',
      );
    }

    const images = await this.loadImages(publication, input.payload.image_asset_ids);
    publication = await this.store.updatePublication(publication, {
      status: 'submitting',
      submittedAt: new Date(),
    });
    try {
      const remote = await this.driver.submit(
        {
          accountId,
          contentFingerprint,
          images,
          payload: input.payload,
          profilePath: this.profilePath(session),
          storageStateJson,
        },
        (png) => this.saveArtifact(publication, 'pre_submit', png),
      );
      const updated = await this.store.updatePublication(publication, {
        remote,
        status: publicationStatus(remote.status),
      });
      await this.saveArtifact(updated, 'post_submit', await this.driver.capture(accountId));
      return publishResponse(updated, remote.status === 'published' ? 'published' : 'processing');
    } catch (error) {
      if (error instanceof PageDriverError) {
        throw await this.handlePageDriverFailure(session, publication, error);
      }
      if (error instanceof PageDriverOperationError) {
        throw await this.handleOperationFailure(session, publication, error);
      }
      throw error;
    }
  }

  private async loadImages(
    publication: PublicationClaim,
    imageAssetIds: readonly string[],
  ): Promise<readonly BrowserImage[]> {
    const assets = await this.store.loadImageAssets(publication, imageAssetIds);
    let totalBytes = 0;
    const images: BrowserImage[] = [];
    for (const asset of assets) {
      if (
        !Number.isSafeInteger(asset.sizeBytes) ||
        asset.sizeBytes < 1 ||
        asset.sizeBytes > 20_000_000
      ) {
        throw new BrowserGatewayError(409, 'IMAGE_ASSET_INVALID', 'Douyin image size is invalid');
      }
      totalBytes += asset.sizeBytes;
      if (totalBytes > 100_000_000) {
        throw new BrowserGatewayError(409, 'IMAGE_ASSET_INVALID', 'Douyin images exceed 100 MB');
      }
      const body = await this.storage.getObject(storageKey(asset.objectUri));
      if (body.byteLength !== asset.sizeBytes || sha256(body) !== asset.contentHash) {
        throw new BrowserGatewayError(
          409,
          'IMAGE_ASSET_INVALID',
          'Douyin image does not match its frozen asset record',
        );
      }
      images.push(Object.freeze({ assetId: asset.assetId, body, mimeType: asset.mimeType }));
    }
    return Object.freeze(images);
  }

  private async reconcile(
    session: BrowserSession,
    publication: PublicationClaim & {
      readonly contentFingerprint?: string;
      readonly submittedAt?: Date | null;
      readonly title?: string;
    },
  ): Promise<RemotePublication | null> {
    try {
      const result = await this.driver.reconcile(
        session.accountId,
        this.profilePath(session),
        {
          contentFingerprint: publication.contentFingerprint ?? '',
          submittedAfter: new Date((publication.submittedAt?.getTime() ?? Date.now()) - 60_000),
          title: publication.title ?? '',
        },
        await this.decryptState(session),
      );
      if (result) {
        await this.saveArtifact(
          publication,
          'reconcile',
          await this.driver.capture(session.accountId),
        );
      }
      return result;
    } catch (error) {
      if (error instanceof PageDriverError) {
        throw await this.handlePageDriverFailure(session, publication, error);
      }
      throw error;
    }
  }

  private async handlePageDriverFailure(
    session: BrowserSession,
    publication: PublicationClaim,
    error: PageDriverError,
  ): Promise<BrowserGatewayError> {
    if (error.code === 'PUBLISH_STATE_UNKNOWN') {
      await this.store.updatePublication(publication, { status: 'unknown' });
      return new BrowserGatewayError(503, error.code, error.message);
    }
    if (error.code === 'AUTH_REQUIRED') {
      await this.requireReauth(session, 'LOGIN_EXPIRED');
      return new BrowserGatewayError(409, error.code, error.message);
    }
    await this.store.markSession(session, {
      error: { code: error.code, schema_version: 'douyin-browser-error@1' },
      status: 'attention_required',
    });
    const updated = await this.store.updatePublication(publication, {
      status: 'manual_required',
    });
    await this.captureAttention(updated).catch(() => undefined);
    return new BrowserGatewayError(423, error.code, error.message);
  }

  private async handleOperationFailure(
    session: BrowserSession,
    publication: PublicationClaim,
    error: PageDriverOperationError,
  ): Promise<BrowserGatewayError> {
    await this.store.markSession(session, {
      error: {
        code: 'EDITOR_OPERATION_FAILED',
        schema_version: 'douyin-browser-error@1',
        stage: error.stage,
      },
      status: 'attention_required',
    });
    const updated = await this.store.updatePublication(publication, {
      status: 'manual_required',
    });
    await this.captureAttention(updated).catch(() => undefined);
    return new BrowserGatewayError(
      423,
      'EDITOR_OPERATION_FAILED',
      'Douyin editor operation failed before a conclusive submission',
      error.stage,
      error,
    );
  }

  private async captureAttention(publication: PublicationClaim): Promise<void> {
    await this.saveArtifact(
      publication,
      'attention_required',
      await this.driver.capture(publication.accountId),
    );
  }

  private async finishLogin(session: BrowserSession, expiresAt: Date): Promise<void> {
    try {
      const authenticated = await this.driver.waitForAuthentication(session.accountId, expiresAt);
      await this.locks.run(session.accountId, async () => {
        const current = await this.store.getSession(session.accountId);
        if (!isCurrentQrAttempt(current, session, expiresAt)) return;
        if (!authenticated) {
          await this.store.markSession(current, {
            error: { code: 'QR_EXPIRED', schema_version: 'douyin-browser-error@1' },
            qrExpiresAt: null,
            status: 'login_required',
          });
          return;
        }
        await this.persistAuthenticatedSession(current);
      });
    } catch (error) {
      console.error('Douyin browser login verification failed', {
        account_id: session.accountId,
        error: safeBrowserError(error),
      });
      try {
        await this.locks.run(session.accountId, async () => {
          const current = await this.store.getSession(session.accountId);
          if (!isCurrentQrAttempt(current, session, expiresAt)) return;
          await this.store.markSession(current, {
            error: {
              code: loginVerificationErrorCode(error),
              schema_version: 'douyin-browser-error@1',
            },
            qrExpiresAt: null,
            status: 'attention_required',
          });
        });
      } catch (persistenceError) {
        console.error('Douyin browser login failure state could not be persisted', {
          account_id: session.accountId,
          error: safeBrowserError(persistenceError),
        });
      }
    }
  }

  private async persistAuthenticatedSession(session: BrowserSession): Promise<BrowserSession> {
    const encrypted = await this.credentials.encrypt(
      await this.driver.exportStorageState(session.accountId),
    );
    const authenticated = await this.store.markSession(session, {
      authenticatedAt: new Date(),
      error: null,
      lastVerifiedAt: new Date(),
      qrExpiresAt: null,
      status: 'authenticated',
      storageStateCiphertext: encrypted.credentialCiphertext,
      storageStateKeyVersion: encrypted.credentialKeyVersion,
    });
    await this.store.markAccountActive(session.accountId, session.tenantId);
    return authenticated;
  }

  private async requireReauth(session: BrowserSession, code: string): Promise<BrowserSession> {
    await this.store.markAccountReauth(session.accountId, session.tenantId);
    return this.store.markSession(session, {
      error: { code, schema_version: 'douyin-browser-error@1' },
      status: 'reauth',
    });
  }

  private decryptState(session: BrowserSession): Promise<string | null> {
    if (!session.storageStateCiphertext || !session.storageStateKeyVersion) {
      return Promise.resolve(null);
    }
    return this.credentials.decrypt({
      credentialCiphertext: session.storageStateCiphertext,
      credentialKeyVersion: session.storageStateKeyVersion,
    });
  }

  private profilePath(session: BrowserSession): string {
    const path = resolve(this.config.profileRoot, session.profileKey);
    const root = resolve(this.config.profileRoot);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new BrowserGatewayError(
        409,
        'PROFILE_SCOPE_INVALID',
        'Browser profile scope is invalid',
      );
    }
    return path;
  }

  private async saveArtifact(
    publication: PublicationClaim,
    kind: 'attention_required' | 'post_submit' | 'pre_submit' | 'reconcile',
    png: Uint8Array,
  ): Promise<void> {
    const hash = sha256(png);
    const key = `douyin-browser/${publication.tenantId}/${publication.accountId}/${publication.id}/${kind}-${hash}.png`;
    const object = await this.storage.putObject({
      body: png,
      contentHash: hash,
      contentType: 'image/png',
      key,
      metadata: { kind, publication_id: publication.id },
    });
    await this.store.insertArtifact(publication, {
      contentHash: hash,
      kind,
      objectUri: object.uri,
    });
  }
}

function sessionView(session: BrowserSession): Readonly<Record<string, unknown>> {
  return Object.freeze({
    account_id: session.accountId,
    authenticated_at: session.authenticatedAt?.toISOString() ?? null,
    last_verified_at: session.lastVerifiedAt?.toISOString() ?? null,
    qr_expires_at: session.qrExpiresAt?.toISOString() ?? null,
    status: session.status,
    version: session.version,
  });
}

function canVerifySession(session: BrowserSession): boolean {
  return session.status === 'authenticated' || session.status === 'attention_required';
}

function isCurrentQrAttempt(
  current: BrowserSession,
  expected: BrowserSession,
  expiresAt: Date,
): boolean {
  return (
    current.status === 'qr_ready' &&
    current.version === expected.version &&
    current.qrExpiresAt?.getTime() === expiresAt.getTime()
  );
}

function loginVerificationErrorCode(error: unknown): string {
  if (error instanceof PageDriverError) return error.code;
  if (error instanceof CredentialEnvelopeError) return 'CREDENTIAL_ENVELOPE_INVALID';
  return 'LOGIN_VERIFICATION_FAILED';
}

function publicationStatus(status: RemotePublication['status']): PublicationClaim['status'] {
  return status;
}

function publishResponse(
  publication: PublicationClaim & {
    readonly externalId?: string | null;
    readonly externalUrl?: string | null;
  },
  status: 'processing' | 'published',
) {
  return Object.freeze({
    external_id: publication.externalId ?? publication.id,
    status,
    url: publication.externalUrl ?? null,
  });
}

function responseStatus(
  publication: PublicationClaim & {
    readonly externalId?: string | null;
    readonly externalUrl?: string | null;
  },
  status: RemotePublication['status'],
) {
  return Object.freeze({
    external_id: publication.externalId ?? publication.id,
    status,
    url: publication.externalUrl ?? null,
  });
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function storageKey(uri: string): string {
  const match = /^(?:s3|memory):\/\/[^/]+\/(.+)$/u.exec(uri);
  if (!match?.[1]) {
    throw new BrowserGatewayError(409, 'IMAGE_ASSET_INVALID', 'Image object URI is invalid');
  }
  const key = decodeURIComponent(match[1]);
  if (!key || key.startsWith('/') || key.includes('..')) {
    throw new BrowserGatewayError(409, 'IMAGE_ASSET_INVALID', 'Image object key is invalid');
  }
  return key;
}

export function toGatewayError(error: unknown): BrowserGatewayError {
  if (error instanceof BrowserGatewayError) return error;
  if (error instanceof BrowserStoreError) {
    return new BrowserGatewayError(
      error.code === 'NOT_FOUND' ? 404 : 409,
      error.code,
      error.message,
    );
  }
  return new BrowserGatewayError(503, 'BROWSER_GATEWAY_UNAVAILABLE', 'Browser operation failed');
}

function sessionVerificationErrorCode(error: unknown): string {
  if (error instanceof CredentialEnvelopeError) return error.code;
  if (error instanceof PageDriverError) return error.code;
  return 'BROWSER_RUNTIME_FAILED';
}

export function safeBrowserError(error: unknown): string {
  const candidate = error as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly name?: unknown;
    readonly stage?: unknown;
  };
  const name = typeof candidate?.name === 'string' ? candidate.name : 'Error';
  const message =
    typeof candidate?.message === 'string' ? candidate.message : String(error ?? 'Unknown error');
  const code = typeof candidate?.code === 'string' ? ` (code=${candidate.code})` : '';
  const stage = typeof candidate?.stage === 'string' ? ` stage=${candidate.stage};` : '';
  return `${name}:${stage} ${redact(message)}${code}`.slice(0, 2_000);
}

function redact(value: string): string {
  return value
    .replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/giu, '$1[REDACTED]@')
    .replaceAll(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replaceAll(
      /((?:api[_-]?key|credential|password|secret|session|storage[_-]?state|token)\s*[:=]\s*)[^&\s,;)]+/giu,
      '$1[REDACTED]',
    );
}
