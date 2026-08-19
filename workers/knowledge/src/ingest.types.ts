import type { DomainEventEnvelope } from '@geo-content-os/contracts';
import type { ParsedMaterialDocument } from '@geo-content-os/parsers';

export const KNOWLEDGE_INGEST_EVENT_TYPES = Object.freeze([
  'knowledge.source.ingest_requested.v1',
  'knowledge.source.reindex_requested.v1',
] as const);

export type KnowledgeIngestEventType = (typeof KNOWLEDGE_INGEST_EVENT_TYPES)[number];
export type IngestStage = 'upload' | 'scan' | 'parse' | 'chunk' | 'embed' | 'index';

export interface KnowledgeIngestData {
  readonly contentHash: string;
  readonly ingestJobId: string;
  readonly objectKey?: string;
  readonly redirectChain: readonly string[];
  readonly sourceDocumentId: string;
  readonly sourceUrl?: string;
  readonly workspaceId: string;
}

export interface ValidatedKnowledgeIngestEvent {
  readonly aggregateId: string;
  readonly data: KnowledgeIngestData;
  readonly eventId: string;
  readonly eventType: KnowledgeIngestEventType;
  readonly occurredAt: string;
  readonly tenantId: string;
}

export interface IngestSource {
  readonly contentHash: string;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly id: string;
  readonly language: string;
  readonly mimeType: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sourceType: 'docx' | 'image' | 'pdf' | 'txt' | 'url';
  readonly status: 'active' | 'processing';
  readonly tenantId: string;
  readonly title: string;
  readonly workspaceId: string;
}

export interface LoadedMaterial {
  readonly body: Uint8Array;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly url?: string;
}

export interface SourceChunkDraft {
  readonly chunkNo: number;
  readonly metadata: object;
  readonly text: string;
  readonly textHash: string;
  readonly tokenCount: number;
}

export interface MaterialLoaderPort {
  load(
    source: IngestSource,
    data: KnowledgeIngestData,
    signal?: AbortSignal,
  ): Promise<LoadedMaterial>;
}

export interface MalwareScannerPort {
  scan(body: Uint8Array, signal?: AbortSignal): Promise<void>;
}

export interface IngestParserPort {
  parse(
    source: IngestSource,
    material: LoadedMaterial,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ParsedMaterialDocument>;
}

export interface MaterialChunkerPort {
  chunk(document: ParsedMaterialDocument): readonly SourceChunkDraft[];
}

export interface IngestClaim {
  readonly attempt: number;
  readonly source: IngestSource;
}

export type IngestClaimResult =
  | { readonly kind: 'claimed'; readonly value: IngestClaim }
  | { readonly kind: 'busy' | 'completed' };

export interface IngestStorePort {
  claim(event: ValidatedKnowledgeIngestEvent): Promise<IngestClaimResult>;
  fail(event: ValidatedKnowledgeIngestEvent, claim: IngestClaim, error: Error): Promise<void>;
  heartbeat(event: ValidatedKnowledgeIngestEvent, claim: IngestClaim): Promise<void>;
  markStage(
    event: ValidatedKnowledgeIngestEvent,
    claim: IngestClaim,
    stage: IngestStage,
    progress: number,
  ): Promise<void>;
  saveChunks(
    event: ValidatedKnowledgeIngestEvent,
    claim: IngestClaim,
    chunks: readonly SourceChunkDraft[],
  ): Promise<void>;
  succeed(
    event: ValidatedKnowledgeIngestEvent,
    claim: IngestClaim,
    modelKey: string,
  ): Promise<void>;
}

export interface KnowledgeIngestResult {
  readonly attempt?: number;
  readonly disposition: 'busy' | 'completed' | 'processed';
  readonly embedded?: number;
  readonly sourceDocumentId: string;
}

export type KnowledgeQueueEvent = DomainEventEnvelope;
