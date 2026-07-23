import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';

import { IngestWorkerError } from './ingest.errors.js';
import type { ValidatedKnowledgeIngestEvent } from './ingest.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const ALLOWED_KEYS = new Set([
  'content_hash',
  'ingest_job_id',
  'object_key',
  'redirect_chain',
  'source_document_id',
  'source_url',
  'workspace_id',
]);

export function validateKnowledgeIngestEvent(raw: unknown): ValidatedKnowledgeIngestEvent {
  const result = DomainEventEnvelopeSchema.safeParse(raw);
  if (!result.success) throw invalidEvent();
  const event = result.data;
  if (
    event.event_type !== 'knowledge.source.ingest_requested.v1' &&
    event.event_type !== 'knowledge.source.reindex_requested.v1'
  ) {
    throw invalidEvent();
  }
  if (event.aggregate.type !== 'source_document') throw invalidEvent();
  if (!isRecord(event.data) || Object.keys(event.data).some((key) => !ALLOWED_KEYS.has(key))) {
    throw invalidEvent();
  }
  const data = event.data;
  if (
    ('object_key' in data && typeof data.object_key !== 'string') ||
    ('source_url' in data && typeof data.source_url !== 'string')
  ) {
    throw invalidEvent();
  }
  const contentHash = value(data.content_hash);
  const ingestJobId = value(data.ingest_job_id);
  const sourceDocumentId = value(data.source_document_id);
  const workspaceId = value(data.workspace_id);
  const redirectChain = data.redirect_chain ?? [];
  if (
    !HASH.test(contentHash) ||
    !UUID.test(ingestJobId) ||
    !UUID.test(sourceDocumentId) ||
    !UUID.test(workspaceId) ||
    sourceDocumentId !== event.aggregate.id ||
    !Array.isArray(redirectChain) ||
    redirectChain.length > 10 ||
    redirectChain.some((entry) => typeof entry !== 'string' || !isHttpUrl(entry))
  ) {
    throw invalidEvent();
  }
  const objectKey = optionalString(data.object_key);
  const sourceUrl = optionalString(data.source_url);
  if (!objectKey && !sourceUrl) throw invalidEvent();
  if (objectKey && !isSafeObjectKey(objectKey)) throw invalidEvent();
  if (sourceUrl && !isHttpUrl(sourceUrl)) throw invalidEvent();
  if (!sourceUrl && redirectChain.length > 0) throw invalidEvent();
  const normalizedRedirectChain = redirectChain.map((entry) => String(entry));
  return Object.freeze({
    aggregateId: event.aggregate.id,
    data: Object.freeze({
      contentHash,
      ingestJobId,
      ...(objectKey ? { objectKey } : {}),
      redirectChain: Object.freeze(normalizedRedirectChain),
      sourceDocumentId,
      ...(sourceUrl ? { sourceUrl } : {}),
      workspaceId,
    }),
    eventId: event.event_id,
    eventType: event.event_type,
    occurredAt: event.occurred_at,
    tenantId: event.tenant.id,
  });
}

function invalidEvent(): IngestWorkerError {
  return new IngestWorkerError('INGEST_EVENT_INVALID', 'Knowledge ingest event is invalid', {
    retryable: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function value(input: unknown): string {
  return typeof input === 'string' ? input : '';
}

function optionalString(input: unknown): string | undefined {
  return typeof input === 'string' && input.length > 0 ? input : undefined;
}

function isHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function isSafeObjectKey(input: string): boolean {
  return (
    input.length <= 1_024 &&
    !input.startsWith('/') &&
    !input.endsWith('/') &&
    !input.includes('..') &&
    /^[A-Za-z0-9][A-Za-z0-9/_=.-]*$/u.test(input)
  );
}
