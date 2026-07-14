import type { DomainEventEnvelope, PlatformCode } from '@geo-content-os/contracts';

import type { ContentMutationAudit } from '../../content/index.js';
import type { ContentScope } from '../../content/repositories/index.js';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface RequestGenerationInput {
  readonly expectedPackageVersion: number;
  readonly modelKey: string;
  readonly packageId: string;
  readonly promptVersionId: string;
  readonly skillVersion: string;
  readonly writerInput: JsonObject;
}

export interface GenerationVariantRunView {
  readonly platformCode: PlatformCode;
  readonly runId: string;
  readonly variantId: string;
}

export interface GenerationRequestResult {
  readonly event: DomainEventEnvelope;
  readonly inputHash: string;
  readonly masterRunId: string;
  readonly variantRuns: readonly GenerationVariantRunView[];
}

export interface GenerationRequestContext {
  readonly audit: ContentMutationAudit;
  readonly scope: ContentScope;
}
