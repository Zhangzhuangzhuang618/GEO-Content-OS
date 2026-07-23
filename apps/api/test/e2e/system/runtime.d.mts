export { migrateDatabase } from '../../../src/database/migrate.js';
export { FREEZE_V21_SEED, seedFreezeV21 } from '../../../src/database/seeds/freeze-v21.seed.js';
export { PasswordHasher } from '../../../src/modules/identity/auth/password-hasher.js';
export { UsageLedgerRepository } from '../../../src/modules/billing/usage/index.js';
export {
  CitationSearchService,
  HybridSearchRepository,
} from '../../../src/modules/knowledge/search/index.js';
export {
  SupportAccessNotFoundError,
  SupportAccessService,
} from '../../../src/modules/platform-access/index.js';
export {
  calculateGeoTotal,
  QualityPipelineRepository,
  QualityPipelineService,
  type QualityEvaluatorPort,
  type QualityPipelineRequest,
  type QualityPipelineScope,
} from '../../../src/modules/quality/pipeline/index.js';
export {
  ReviewDecisionService,
  type ReviewDecisionScope,
} from '../../../src/modules/review/decisions/index.js';
export {
  SubmitReviewService,
  type SubmitReviewScope,
} from '../../../src/modules/review/submit/index.js';
export {
  PublishJobService,
  type PublishJobScope,
} from '../../../src/modules/publishing/jobs/index.js';
export {
  MetricsImportService,
  type MetricsImportScope,
} from '../../../src/modules/analytics/imports/index.js';
export {
  AnalyticsQueryService,
  type AnalyticsQueryScope,
} from '../../../src/modules/analytics/queries/index.js';
export { MetricRegistry } from '../../../src/modules/analytics/repositories/index.js';
export { OutboxWriter } from '../../../src/modules/outbox/index.js';

import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import type { PlatformCode } from '@geo-content-os/contracts';
import type { CredentialEnvelopeService } from '@geo-content-os/security/credentials';
import type postgres from 'postgres';

export interface PublishClaim {
  readonly content: Readonly<Record<string, unknown>>;
  readonly contentVersionId: string;
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly payloadHash: string;
  readonly platformCode: PlatformCode;
  readonly publishMode: 'api' | 'export' | 'manual';
  readonly tenantId: string;
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
}

export class PostgresPublisherStore {
  public constructor(client: postgres.Sql, staleAfterMs?: number);
}

export class PublisherWorker {
  public constructor(
    dependencies: {
      readonly platform: PublisherPlatformPort;
      readonly storage: ObjectStorageAdapter;
      readonly store: PostgresPublisherStore;
    },
    credentials: CredentialEnvelopeService,
  );
  public run(
    rawEvent: unknown,
    signal?: AbortSignal,
  ): Promise<{
    readonly attempt?: number;
    readonly disposition: 'busy' | 'completed' | 'processed' | 'unknown';
    readonly jobId: string;
    readonly mode?: 'api' | 'export';
  }>;
}

export class OutboxRelayStore {
  public constructor(client: postgres.Sql);
  public releaseExpiredLeases(leaseDurationMs: number): Promise<number>;
}
