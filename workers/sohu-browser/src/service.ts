import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve, sep } from 'node:path';

import { hashSohuPayload } from '@geo-content-os/adapter-platforms/sohu/delivery';
import { SohuDeliveryInputSchema } from '@geo-content-os/adapter-platforms/sohu/delivery';
import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import type { SohuBrowserLoginRequest } from '@geo-content-os/contracts';
import {
  CredentialEnvelopeError,
  type CredentialEnvelopeService,
} from '@geo-content-os/security/credentials';

import { AccountLock } from './account-lock.js';
import type { SohuBrowserConfig } from './config.js';
import { PageDriverError, PageDriverOperationError } from './page-driver.js';
import { BrowserStoreError } from './store.js';
import type { PostgresSohuBrowserStore } from './store.js';
import type {
  SohuPageDriver,
  BrowserPublishInput,
  BrowserImage,
  BrowserSession,
  PublicationClaim,
  RemotePublication,
} from './types.js';

const RESUBMIT_GRACE_MS = 2 * 60_000;

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

export class SohuBrowserService {
  private readonly locks = new AccountLock();

  public constructor(
    private readonly config: SohuBrowserConfig,
    private readonly store: PostgresSohuBrowserStore,
    private readonly driver: SohuPageDriver,
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

  public async startLogin(
    accountId: string,
    input: SohuBrowserLoginRequest = { method: 'wechat' },
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.locks.run(accountId, async () => {
      const session = await this.store.getOrCreateSession(accountId);
      let result: Awaited<ReturnType<SohuPageDriver['startLogin']>>;
      try {
        result = await this.driver.startLogin(accountId, this.profilePath(session), input);
      } catch (error) {
        if (
          error instanceof PageDriverError &&
          (error.code === 'CAPTCHA_REQUIRED' || error.code === 'PAGE_SIGNATURE_CHANGED')
        ) {
          await this.store.markSession(session, {
            error: { code: error.code, schema_version: 'sohu-browser-error@1' },
            qrExpiresAt: null,
            status: 'attention_required',
          });
          throw new BrowserGatewayError(423, error.code, error.message);
        }
        if (error instanceof PageDriverError) {
          throw new BrowserGatewayError(423, error.code, error.message);
        }
        throw error;
      }
      if (result.captchaPng) {
        const pending = await this.store.markSession(session, {
          error: null,
          qrExpiresAt: null,
          status: 'login_required',
        });
        return Object.freeze({
          ...sessionView(pending),
          captcha_image_data_url: `data:image/png;base64,${Buffer.from(result.captchaPng).toString('base64')}`,
          login_stage: 'captcha_required',
        });
      }
      if (result.smsCodeRequired) {
        const pending = await this.store.markSession(session, {
          error: null,
          qrExpiresAt: null,
          status: 'login_required',
        });
        return Object.freeze({ ...sessionView(pending), login_stage: 'sms_code_required' });
      }
      if (result.qrPng.byteLength === 0) {
        const authenticated = await this.persistAuthenticatedSession(session);
        return sessionView(authenticated);
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
    });
  }

  public async sessionStatus(accountId: string): Promise<Readonly<Record<string, unknown>>> {
    const session = await this.store.getSession(accountId);
    if (!canVerifySession(session)) return sessionView(session);
    return this.locks.run(accountId, async () => {
      const current = await this.store.getSession(accountId);
      if (
        !canVerifySession(current) ||
        (session.status === 'authenticated' && current.status !== 'authenticated')
      ) {
        return sessionView(current);
      }
      try {
        const storageState = await this.decryptState(current);
        const authenticated = await this.driver.verifyAuthenticated(
          accountId,
          this.profilePath(current),
          storageState,
        );
        if (!authenticated) return sessionView(await this.requireReauth(current, 'LOGIN_EXPIRED'));
        const verified = await this.store.markSession(current, {
          error: null,
          lastVerifiedAt: new Date(),
          status: 'authenticated',
        });
        return sessionView(verified);
      } catch (error) {
        const code = sessionVerificationErrorCode(error);
        console.error('Sohu browser session verification failed', {
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
        const attention = await this.store.markSession(current, {
          error: { code, schema_version: 'sohu-browser-error@1' },
          status: 'attention_required',
        });
        return sessionView(attention);
      }
    });
  }

  public async reauthenticate(
    accountId: string,
    input: SohuBrowserLoginRequest = { method: 'wechat' },
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.startLogin(accountId, input);
  }

  public async publish(
    accountId: string,
    raw: unknown,
  ): Promise<{
    readonly external_id: string;
    readonly status: 'processing' | 'published';
    readonly url: string | null;
  }> {
    const parsed = SohuDeliveryInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new BrowserGatewayError(400, 'SCHEMA_INVALID', 'Publish payload is invalid');
    if (hashSohuPayload(parsed.data.payload) !== parsed.data.payload_hash) {
      throw new BrowserGatewayError(
        409,
        'PAYLOAD_HASH_MISMATCH',
        'Frozen payload hash does not match',
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
      if (
        publication.status === 'published' ||
        publication.status === 'failed' ||
        publication.status === 'manual_required'
      ) {
        if (publication.status === 'manual_required') {
          return responseStatus(publication, 'unknown');
        }
        return responseStatus(publication, publication.status);
      }
      const session = await this.store.getSession(accountId);
      const remote = await this.reconcile(session, publication);
      if (!remote) return responseStatus(publication, 'unknown');
      const status = publicationStatus(remote.status);
      const updated = await this.store.updatePublication(publication, { remote, status });
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
        'Sohu browser automation is paused for manual attention; login has not been marked expired',
      );
    }
    if (session.status !== 'authenticated') {
      throw new BrowserGatewayError(409, 'AUTH_REQUIRED', 'Sohu browser login is required');
    }
    const storageStateJson = await this.decryptState(session);
    const authenticated = await this.driver.verifyAuthenticated(
      accountId,
      this.profilePath(session),
      storageStateJson,
    );
    if (!authenticated) {
      session = await this.requireReauth(session, 'LOGIN_EXPIRED');
      void session;
      throw new BrowserGatewayError(409, 'AUTH_REQUIRED', 'Sohu browser login has expired');
    }
    const contentFingerprint = sha256(
      `${input.payload.title}\n${normalizeText(input.payload.body_text)}`,
    );
    let publication = await this.store.preparePublication(accountId, input, contentFingerprint);
    if (publication.status === 'published') return publishResponse(publication, 'published');
    if (publication.status === 'failed' || publication.status === 'manual_required') {
      throw new BrowserGatewayError(
        409,
        'PUBLICATION_TERMINAL',
        'Publication requires manual handling',
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
          throw new BrowserGatewayError(409, 'PUBLISH_REJECTED', 'Sohu rejected publication');
        }
        return publishResponse(updated, remote.status === 'published' ? 'published' : 'processing');
      }
      const submittedAt = 'submittedAt' in publication ? publication.submittedAt : null;
      if (!submittedAt || Date.now() - submittedAt.getTime() < RESUBMIT_GRACE_MS) {
        throw new BrowserGatewayError(
          503,
          'PUBLISH_STATE_UNKNOWN',
          'Publication is not yet visible in the content list; retry only after reconciliation',
        );
      }
      publication = await this.store.updatePublication(publication, { status: 'prepared' });
    }
    publication = await this.store.updatePublication(publication, {
      status: 'submitting',
      submittedAt: new Date(),
    });
    try {
      const images = await this.loadImages(publication, input);
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
      if (remote.status === 'failed') {
        throw new BrowserGatewayError(409, 'PUBLISH_REJECTED', 'Sohu rejected publication');
      }
      return publishResponse(updated, remote.status === 'published' ? 'published' : 'processing');
    } catch (error) {
      if (error instanceof PageDriverError) {
        throw await this.handlePageDriverFailure(session, publication, error);
      }
      if (error instanceof PageDriverOperationError) {
        throw await this.handlePageDriverOperationFailure(session, publication, error);
      }
      throw error;
    }
  }

  private async loadImages(
    publication: PublicationClaim,
    input: BrowserPublishInput,
  ): Promise<readonly BrowserImage[]> {
    const assets = await this.store.loadImageAssets(
      publication,
      input.payload.cover_asset_id,
      input.payload.body_asset_ids,
    );
    let totalBytes = 0;
    const images: BrowserImage[] = [];
    for (const asset of assets) {
      if (
        !Number.isSafeInteger(asset.sizeBytes) ||
        asset.sizeBytes < 1 ||
        asset.sizeBytes > 10_000_000
      ) {
        throw new BrowserGatewayError(409, 'IMAGE_ASSET_INVALID', 'Sohu image size is invalid');
      }
      totalBytes += asset.sizeBytes;
      if (totalBytes > 50_000_000) {
        throw new BrowserGatewayError(409, 'IMAGE_ASSET_INVALID', 'Sohu images exceed 50 MB');
      }
      const body = await this.storage.getObject(storageKey(asset.objectUri));
      if (body.byteLength !== asset.sizeBytes || sha256(body) !== asset.contentHash) {
        throw new BrowserGatewayError(
          409,
          'IMAGE_ASSET_INVALID',
          'Sohu image does not match its frozen asset record',
        );
      }
      images.push(
        Object.freeze({
          assetId: asset.assetId,
          body,
          mimeType: asset.mimeType,
          role: asset.role,
        }),
      );
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
    const storageState = await this.decryptState(session);
    try {
      const result = await this.driver.reconcile(
        session.accountId,
        this.profilePath(session),
        {
          contentFingerprint: publication.contentFingerprint ?? '',
          submittedAfter: new Date((publication.submittedAt?.getTime() ?? Date.now()) - 60_000),
          title: publication.title ?? '',
        },
        storageState,
      );
      if (result)
        await this.saveArtifact(
          publication,
          'reconcile',
          await this.driver.capture(session.accountId),
        );
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
      error: { code: error.code, schema_version: 'sohu-browser-error@1' },
      status: 'attention_required',
    });
    const updated = await this.store.updatePublication(publication, {
      status: 'manual_required',
    });
    try {
      await this.saveArtifact(
        updated,
        'attention_required',
        await this.driver.capture(session.accountId),
      );
    } catch {
      // The durable manual-required state is authoritative if screenshot capture is unavailable.
    }
    return new BrowserGatewayError(423, error.code, error.message);
  }

  private async handlePageDriverOperationFailure(
    session: BrowserSession,
    publication: PublicationClaim,
    error: PageDriverOperationError,
  ): Promise<BrowserGatewayError> {
    const code = 'EDITOR_OPERATION_FAILED';
    await this.store.markSession(session, {
      error: { code, schema_version: 'sohu-browser-error@1', stage: error.stage },
      status: 'attention_required',
    });
    const updated = await this.store.updatePublication(publication, {
      status: 'manual_required',
    });
    try {
      await this.saveArtifact(
        updated,
        'attention_required',
        await this.driver.capture(session.accountId),
      );
    } catch {
      // The durable manual-required state is authoritative if screenshot capture is unavailable.
    }
    return new BrowserGatewayError(
      423,
      code,
      'Sohu editor operation failed before submission and requires manual attention',
      error.stage,
      error,
    );
  }

  private async finishLogin(session: BrowserSession, expiresAt: Date): Promise<void> {
    try {
      const authenticated = await this.driver.waitForAuthentication(session.accountId, expiresAt);
      await this.locks.run(session.accountId, async () => {
        const current = await this.store.getSession(session.accountId);
        if (!authenticated) {
          if (current.status !== 'qr_ready') return;
          await this.store.markSession(current, {
            error: { code: 'QR_EXPIRED', schema_version: 'sohu-browser-error@1' },
            qrExpiresAt: null,
            status: 'login_required',
          });
          return;
        }
        await this.persistAuthenticatedSession(current);
      });
    } catch (error) {
      const code = error instanceof PageDriverError ? error.code : 'LOGIN_VERIFICATION_FAILED';
      console.error('Sohu browser login verification failed', {
        account_id: session.accountId,
        error: safeBrowserError(error),
        error_code: code,
      });
      try {
        await this.locks.run(session.accountId, async () => {
          const current = await this.store.getSession(session.accountId);
          if (current.status !== 'qr_ready') return;
          await this.store.markSession(current, {
            error: { code, schema_version: 'sohu-browser-error@1' },
            qrExpiresAt: null,
            status: 'attention_required',
          });
        });
      } catch {
        // A later status request can recover if persistence is temporarily unavailable.
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
      error: { code, schema_version: 'sohu-browser-error@1' },
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
    const key = `sohu-browser/${publication.tenantId}/${publication.accountId}/${publication.id}/${kind}-${hash}.png`;
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

function publicationStatus(status: RemotePublication['status']): PublicationClaim['status'] {
  if (status === 'unknown') return 'unknown';
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
    const status = error.code === 'NOT_FOUND' ? 404 : 409;
    return new BrowserGatewayError(status, error.code, error.message);
  }
  return new BrowserGatewayError(503, 'BROWSER_GATEWAY_UNAVAILABLE', 'Browser operation failed');
}

function sessionVerificationErrorCode(error: unknown): string {
  if (error instanceof CredentialEnvelopeError) return error.code;
  if (error instanceof PageDriverError) return error.code;
  return 'BROWSER_RUNTIME_FAILED';
}

export function safeBrowserError(error: unknown): string {
  return safeBrowserErrorValue(error, 3).slice(0, 2_000);
}

function safeBrowserErrorValue(error: unknown, remainingCauseDepth: number): string {
  const candidate =
    error !== null && (typeof error === 'object' || typeof error === 'function')
      ? (error as {
          readonly code?: unknown;
          readonly cause?: unknown;
          readonly message?: unknown;
          readonly name?: unknown;
          readonly stage?: unknown;
        })
      : {};
  const name = typeof candidate.name === 'string' ? candidate.name : 'Error';
  const message =
    typeof candidate.message === 'string' ? candidate.message : String(error ?? 'Unknown error');
  const code = typeof candidate.code === 'string' ? ` (code=${candidate.code})` : '';
  const stage = typeof candidate.stage === 'string' ? ` stage=${candidate.stage};` : '';
  const cause =
    remainingCauseDepth > 0 && candidate.cause !== undefined && candidate.cause !== error
      ? ` cause=${safeBrowserErrorValue(candidate.cause, remainingCauseDepth - 1)}`
      : '';
  return `${name}:${stage} ${redactBrowserError(message)}${code}${cause}`;
}

function redactBrowserError(value: string): string {
  return value
    .replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/giu, '$1[REDACTED]@')
    .replaceAll(/((?:set-cookie|cookie|authorization):\s*)[^\r\n]+/giu, '$1[REDACTED]')
    .replaceAll(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replaceAll(
      /((?:api[_-]?key|credential|password|secret|session|storage[_-]?state|token)\s*[:=]\s*)[^&\s,;)]+/giu,
      '$1[REDACTED]',
    );
}
