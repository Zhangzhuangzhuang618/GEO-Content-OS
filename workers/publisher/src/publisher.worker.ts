import type { CredentialEnvelopeService } from '@geo-content-os/security/credentials';
import { createHash } from 'node:crypto';

import { asDeliveryFailure, PublisherError } from './publisher.errors.js';
import { validateBaijiahaoReconcileEvent } from './baijiahao-reconcile.event.js';
import { validatePublishEvent } from './publisher.event.js';
import type {
  BaijiahaoReconcileClaim,
  NormalizedExport,
  PlatformDelivery,
  PublishClaim,
  PublisherWorkerDependencies,
  PublisherWorkerResult,
  ValidatedPublishEvent,
} from './publisher.types.js';

export class PublisherWorker {
  public constructor(
    private readonly dependencies: PublisherWorkerDependencies,
    private readonly credentials: CredentialEnvelopeService,
  ) {}

  public async run(rawEvent: unknown, signal?: AbortSignal): Promise<PublisherWorkerResult> {
    const event = validatePublishEvent(rawEvent);
    const claimed = await this.dependencies.store.claim(event);
    if (claimed.kind !== 'claimed') {
      return Object.freeze({ disposition: claimed.kind, jobId: event.jobId });
    }
    const claim = claimed.value;
    if (
      claim.accountStatus !== 'active' ||
      (claim.accountTokenExpiresAt !== null && claim.accountTokenExpiresAt <= new Date())
    ) {
      await this.dependencies.store.fail(event, claim, {
        code: 'ADAPTER_AUTH_EXPIRED',
        message: 'Platform account authorization has expired',
        requestHash: claim.payloadHash,
        status: 'failed',
      });
      return terminal(event, claim, 'processed');
    }
    let credential: Readonly<Record<string, unknown>> | null;
    try {
      credential = await this.decryptCredential(claim);
    } catch {
      await this.dependencies.store.fail(event, claim, {
        code: 'ADAPTER_AUTH_EXPIRED',
        message: 'Platform credential could not be decrypted',
        requestHash: claim.payloadHash,
        status: 'failed',
      });
      return terminal(event, claim, 'processed');
    }

    let delivery: PlatformDelivery;
    try {
      delivery = await this.dependencies.platform.deliver(claim, credential, signal);
      if (
        delivery.mode === 'export' &&
        ['baijiahao', 'sohu'].includes(claim.platformCode) &&
        claim.publishMode === 'api'
      ) {
        throw Object.assign(new Error('Baijiahao browser capability is temporarily unavailable'), {
          code: 'CAPABILITY_UNAVAILABLE',
        });
      }
    } catch (error) {
      const failure = asDeliveryFailure(error);
      const unknown = failure.code === 'PUBLISH_STATE_UNKNOWN' || failure.code === undefined;
      if (
        ['official_site', 'baijiahao', 'sohu'].includes(claim.platformCode) &&
        claim.attempt < 3 &&
        (unknown || failure.code === 'CAPABILITY_UNAVAILABLE')
      ) {
        await this.dependencies.store.retry(event, claim, {
          code: failure.code ?? 'PUBLISH_STATE_UNKNOWN',
          message: safeMessage(failure.message),
          requestHash: claim.payloadHash,
        });
        throw new PublisherError(
          'PUBLISHER_DELIVERY_RETRY',
          `${claim.platformCode} publication will retry with the same idempotency key`,
          true,
        );
      }
      await this.dependencies.store.fail(event, claim, {
        code: failure.code ?? 'PUBLISH_STATE_UNKNOWN',
        message: safeMessage(failure.message),
        requestHash: claim.payloadHash,
        status: unknown ? 'unknown' : 'failed',
      });
      return terminal(event, claim, unknown ? 'unknown' : 'processed');
    }

    if (delivery.mode === 'api') {
      await this.dependencies.store.complete(event, claim, delivery);
      return Object.freeze({
        attempt: claim.attempt,
        disposition: 'processed',
        jobId: event.jobId,
        mode: delivery.mode,
      });
    }

    let artifact: NormalizedExport;
    try {
      artifact = normalizeExport(event, claim, delivery);
      const stored = await this.dependencies.storage.putObject({
        body: artifact.body,
        contentHash: artifact.contentHash,
        contentType: 'application/json',
        key: artifact.objectKey,
        metadata: {
          job_id: claim.jobId,
          payload_hash: delivery.payloadHash,
          schema_version: 'export-manifest@1',
        },
      });
      await this.dependencies.store.complete(event, claim, delivery, {
        contentHash: artifact.contentHash,
        manifest: artifact.manifest,
        objectUri: stored.uri,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export storage failed';
      await this.dependencies.store.retry(event, claim, {
        code: 'EXPORT_STORAGE_FAILED',
        message: safeMessage(message),
        requestHash: delivery.payloadHash,
      });
      throw new PublisherError('PUBLISHER_STORAGE_FAILED', 'Export storage failed', true);
    }
    return Object.freeze({
      attempt: claim.attempt,
      disposition: 'processed',
      jobId: event.jobId,
      mode: delivery.mode,
    });
  }

  public async reconcileBaijiahao(
    rawEvent: unknown,
    signal?: AbortSignal,
  ): Promise<PublisherWorkerResult> {
    const event = validateBaijiahaoReconcileEvent(rawEvent);
    const claimStore = this.dependencies.store.claimBaijiahaoReconciliation;
    const completeStore = this.dependencies.store.completeBaijiahaoReconciliation;
    const getStatus = this.dependencies.platform.getBaijiahaoStatus;
    if (!claimStore || !completeStore || !getStatus) {
      throw new PublisherError(
        'PUBLISHER_STATE_INVALID',
        'Baijiahao reconciliation is not configured',
      );
    }
    const claimed = await claimStore.call(this.dependencies.store, event);
    if (claimed.kind === 'completed') {
      return Object.freeze({ disposition: 'completed', jobId: event.jobId });
    }
    const claim = claimed.value;
    if (
      claim.accountStatus !== 'active' ||
      (claim.accountTokenExpiresAt !== null && claim.accountTokenExpiresAt <= new Date())
    ) {
      throw new PublisherError(
        'PUBLISHER_AUTH_INVALID',
        'Baijiahao account authorization has expired',
      );
    }
    const credential = await this.decryptReconcileCredential(claim);
    let status;
    try {
      status = await getStatus.call(this.dependencies.platform, claim, credential, signal);
    } catch (error) {
      const failure = asDeliveryFailure(error);
      status = Object.freeze({
        externalId: claim.externalId,
        status: 'unknown' as const,
        url: null,
      });
      if (failure.code === 'ADAPTER_AUTH_EXPIRED') throw error;
    }
    const disposition = await completeStore.call(this.dependencies.store, event, claim, status);
    return Object.freeze({
      disposition: disposition === 'pending' ? 'processed' : 'completed',
      jobId: event.jobId,
      mode: 'api',
    });
  }

  private async decryptCredential(
    claim: PublishClaim,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    if (claim.publishMode !== 'api') return null;
    if (!claim.credentialCiphertext || !claim.credentialKeyVersion) {
      throw new PublisherError('PUBLISHER_AUTH_INVALID', 'Platform credential is missing');
    }
    const plaintext = await this.credentials.decrypt({
      credentialCiphertext: claim.credentialCiphertext,
      credentialKeyVersion: claim.credentialKeyVersion,
    });
    const parsed = JSON.parse(plaintext) as unknown;
    if (!isRecord(parsed)) {
      throw new PublisherError('PUBLISHER_AUTH_INVALID', 'Platform credential is invalid');
    }
    return parsed;
  }

  private async decryptReconcileCredential(
    claim: BaijiahaoReconcileClaim,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!claim.credentialCiphertext || !claim.credentialKeyVersion) {
      throw new PublisherError('PUBLISHER_AUTH_INVALID', 'Platform credential is missing');
    }
    const plaintext = await this.credentials.decrypt({
      credentialCiphertext: claim.credentialCiphertext,
      credentialKeyVersion: claim.credentialKeyVersion,
    });
    const parsed = JSON.parse(plaintext) as unknown;
    if (!isRecord(parsed)) {
      throw new PublisherError('PUBLISHER_AUTH_INVALID', 'Platform credential is invalid');
    }
    return parsed;
  }
}

function normalizeExport(
  event: ValidatedPublishEvent,
  claim: PublishClaim,
  delivery: Extract<PlatformDelivery, { readonly mode: 'export' }>,
): NormalizedExport {
  const manifest = Object.freeze({
    files: exportFiles(delivery.bundle),
    payload_hash: delivery.payloadHash,
    platform_code: claim.platformCode,
    schema_version: 'export-manifest@1',
  });
  const body = new TextEncoder().encode(stableStringify(delivery.bundle));
  return Object.freeze({
    body,
    contentHash: createHash('sha256').update(body).digest('hex'),
    manifest,
    objectKey: `tenants/${event.tenantId}/publishing/${claim.jobId}/attempt-${claim.attempt}.json`,
  });
}

function exportFiles(bundle: unknown): readonly unknown[] {
  if (!isRecord(bundle)) return Object.freeze([]);
  return Array.isArray(bundle['files']) ? Object.freeze([...bundle['files']]) : Object.freeze([]);
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function terminal(
  event: ValidatedPublishEvent,
  claim: PublishClaim,
  disposition: 'processed' | 'unknown',
): PublisherWorkerResult {
  return Object.freeze({ attempt: claim.attempt, disposition, jobId: event.jobId });
}

function safeMessage(value: string): string {
  const normalized = value.trim();
  return (normalized || 'Platform delivery failed').slice(0, 2_000);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
