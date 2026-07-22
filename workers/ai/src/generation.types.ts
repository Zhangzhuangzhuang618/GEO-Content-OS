import type { PlatformCode } from '@geo-content-os/contracts';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ContentBlockType = 'cta' | 'heading' | 'list' | 'media' | 'paragraph' | 'quote';

export interface GeneratedContent extends JsonObject {
  readonly blocks: readonly GeneratedContentBlock[];
  readonly platform_code: PlatformCode | 'master';
  readonly schema_version: string;
}

export interface GeneratedContentBlock extends JsonObject {
  readonly block_key: string;
  readonly block_type: ContentBlockType;
  readonly text: string;
}

export interface VariantGenerationRun {
  readonly platformCode: PlatformCode;
  readonly runId: string;
  readonly variantId: string;
}

export interface GenerationEventData {
  readonly actorUserId: string;
  readonly inputHash: string;
  readonly masterRunId: string;
  readonly modelKey: string;
  readonly modelPolicy: 'balanced' | 'fast' | 'quality';
  readonly packageId: string;
  readonly projectId: string;
  readonly promptVersionId: string;
  readonly requestId: string;
  readonly skillVersion: string;
  readonly variantRuns: readonly VariantGenerationRun[];
  readonly workspaceId: string;
  readonly writerInput: JsonObject;
}

export interface ValidatedGenerationEvent {
  readonly data: GenerationEventData;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly tenantId: string;
}

export interface ContentWriterPort {
  generateMaster(input: {
    readonly context: ContentWriterRunContext;
    readonly requestId: string;
    readonly signal?: AbortSignal;
    readonly writerInput: JsonObject;
  }): Promise<GeneratedContent>;
  generateVariant(input: {
    readonly context: ContentWriterRunContext;
    readonly masterContent: GeneratedContent;
    readonly platformCode: PlatformCode;
    readonly requestId: string;
    readonly signal?: AbortSignal;
    readonly writerInput: JsonObject;
  }): Promise<GeneratedContent>;
}

export interface ContentWriterRunContext {
  readonly batchKey: string;
  readonly inputHash: string;
  readonly modelKey: string;
  readonly modelPolicy: 'balanced' | 'fast' | 'quality';
  readonly packageId: string;
  readonly projectId: string;
  readonly promptVersionId: string;
  readonly runId: string;
  readonly skillVersion: string;
  readonly skillName: 'content-writer';
  readonly tenantId: string;
  readonly variantId: string | null;
  readonly workspaceId: string;
}

export interface GenerationClaim {
  readonly leaseVersion: number | null;
  readonly masterAlreadySucceeded: boolean;
}

export type GenerationClaimResult =
  | { readonly kind: 'busy' | 'completed' }
  | { readonly kind: 'claimed'; readonly value: GenerationClaim };

export interface VariantClaim {
  readonly leaseVersion: number;
  readonly run: VariantGenerationRun;
}

export type VariantClaimResult =
  | { readonly kind: 'busy' | 'completed' }
  | { readonly kind: 'claimed'; readonly value: VariantClaim };

export interface GenerationFailure {
  readonly code: string;
  readonly message: string;
}

export interface GenerationStorePort {
  claim(event: ValidatedGenerationEvent): Promise<GenerationClaimResult>;
  claimVariant(
    event: ValidatedGenerationEvent,
    run: VariantGenerationRun,
  ): Promise<VariantClaimResult>;
  failMaster(
    event: ValidatedGenerationEvent,
    leaseVersion: number,
    failure: GenerationFailure,
  ): Promise<void>;
  failVariant(
    event: ValidatedGenerationEvent,
    claim: VariantClaim,
    failure: GenerationFailure,
  ): Promise<void>;
  finalize(event: ValidatedGenerationEvent): Promise<'all_failed' | 'generated' | 'generating'>;
  heartbeat(event: ValidatedGenerationEvent, runId: string, leaseVersion: number): Promise<void>;
  loadMaster(event: ValidatedGenerationEvent): Promise<GeneratedContent>;
  saveMaster(
    event: ValidatedGenerationEvent,
    leaseVersion: number,
    content: GeneratedContent,
  ): Promise<void>;
  saveVariant(
    event: ValidatedGenerationEvent,
    claim: VariantClaim,
    content: GeneratedContent,
  ): Promise<void>;
}

export interface GenerationWorkerResult {
  readonly disposition: 'busy' | 'completed' | 'processed';
  readonly failed: number;
  readonly packageId: string;
  readonly packageStatus?: 'all_failed' | 'generated' | 'generating';
  readonly succeeded: number;
}
