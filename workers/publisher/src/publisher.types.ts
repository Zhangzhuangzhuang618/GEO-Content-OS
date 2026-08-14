import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import type { PlatformCode } from '@geo-content-os/contracts';

export interface ValidatedPublishEvent {
  readonly eventId: string;
  readonly jobId: string;
  readonly jobVersion: number;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly scheduledAt: string;
  readonly tenantId: string;
}

export interface ValidatedBaijiahaoReconcileEvent {
  readonly eventId: string;
  readonly jobId: string;
  readonly jobVersion: number;
  readonly occurredAt: string;
  readonly platformCode: 'baijiahao' | 'lieju' | 'sohu';
  readonly reconcileAttempt: number;
  readonly requestId: string;
  readonly tenantId: string;
}

export interface PublishCitationLink {
  readonly citation_id: string;
  readonly label: string;
  readonly url: string;
}

export interface PublishMediaAsset {
  readonly altText: string;
  readonly contentHash: string;
  readonly id: string;
  readonly mimeType: string;
  readonly objectUri: string;
  readonly position: number;
  readonly publicUrl: string | null;
  readonly role: 'body' | 'cover';
  readonly sizeBytes: number;
}

export interface PublishClaim {
  readonly accountId: string;
  readonly accountStatus: 'active' | 'disabled' | 'reauth';
  readonly accountTokenExpiresAt: Date | null;
  readonly attempt: number;
  readonly content: Readonly<Record<string, unknown>>;
  readonly contentVersionId: string;
  readonly credentialCiphertext: string | null;
  readonly credentialKeyVersion: string | null;
  readonly citations: readonly PublishCitationLink[];
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly mediaAssets?: readonly PublishMediaAsset[];
  readonly payloadHash: string;
  readonly platformCode: PlatformCode;
  readonly publishMode: 'api' | 'export' | 'manual';
  readonly tenantId: string;
}

export interface BaijiahaoReconcileClaim {
  readonly accountId: string;
  readonly accountStatus: 'active' | 'disabled' | 'reauth';
  readonly accountTokenExpiresAt: Date | null;
  readonly attempt: number;
  readonly contentVersionId: string;
  readonly credentialCiphertext: string | null;
  readonly credentialKeyVersion: string | null;
  readonly externalId: string;
  readonly jobId: string;
  readonly jobVersion: number;
  readonly platformCode: 'baijiahao' | 'lieju' | 'sohu';
  readonly publishMode: 'api';
  readonly tenantId: string;
}

export interface BaijiahaoRemoteStatus {
  readonly externalId: string;
  readonly status: 'failed' | 'processing' | 'published' | 'unknown';
  readonly url: string | null;
}

export type PublishClaimResult =
  | { readonly kind: 'busy' | 'completed' }
  | { readonly kind: 'claimed'; readonly value: PublishClaim };

export interface NormalizedExport {
  readonly body: Uint8Array;
  readonly contentHash: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly objectKey: string;
}

export type PlatformDelivery =
  | {
      readonly externalId: string;
      readonly mode: 'api';
      readonly payloadHash: string;
      readonly response: Readonly<Record<string, unknown>>;
      readonly url: string | null;
    }
  | {
      readonly bundle: unknown;
      readonly mode: 'export';
      readonly payloadHash: string;
    };

export interface PublisherPlatformPort {
  deliver(
    claim: PublishClaim,
    credential: Readonly<Record<string, unknown>> | null,
    signal?: AbortSignal,
  ): Promise<PlatformDelivery>;
  getBaijiahaoStatus?(
    claim: BaijiahaoReconcileClaim,
    credential: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<BaijiahaoRemoteStatus>;
}

export interface PublisherStorePort {
  claim(event: ValidatedPublishEvent): Promise<PublishClaimResult>;
  complete(
    event: ValidatedPublishEvent,
    claim: PublishClaim,
    delivery: PlatformDelivery,
    artifact?: {
      readonly contentHash: string;
      readonly manifest: Readonly<Record<string, unknown>>;
      readonly objectUri: string;
    },
  ): Promise<void>;
  fail(
    event: ValidatedPublishEvent,
    claim: PublishClaim,
    failure: {
      readonly code: string;
      readonly message: string;
      readonly requestHash: string;
      readonly status: 'failed' | 'unknown';
    },
  ): Promise<void>;
  retry(
    event: ValidatedPublishEvent,
    claim: PublishClaim,
    failure: { readonly code: string; readonly message: string; readonly requestHash: string },
  ): Promise<void>;
  claimBaijiahaoReconciliation?(
    event: ValidatedBaijiahaoReconcileEvent,
  ): Promise<
    | { readonly kind: 'completed' }
    | { readonly kind: 'claimed'; readonly value: BaijiahaoReconcileClaim }
  >;
  completeBaijiahaoReconciliation?(
    event: ValidatedBaijiahaoReconcileEvent,
    claim: BaijiahaoReconcileClaim,
    result: BaijiahaoRemoteStatus,
  ): Promise<'completed' | 'pending'>;
}

export interface PublisherWorkerDependencies {
  readonly platform: PublisherPlatformPort;
  readonly storage: ObjectStorageAdapter;
  readonly store: PublisherStorePort;
}

export interface PublisherWorkerResult {
  readonly attempt?: number;
  readonly disposition: 'busy' | 'completed' | 'processed' | 'unknown';
  readonly jobId: string;
  readonly mode?: 'api' | 'export';
}
