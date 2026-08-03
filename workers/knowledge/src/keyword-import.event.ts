import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';

export interface KeywordImportEvent {
  readonly eventId: string;
  readonly importJobId: string;
  readonly keywordSetId: string;
  readonly occurredAt: string;
  readonly tenantId: string;
}

export function validateKeywordImportEvent(value: unknown): KeywordImportEvent {
  const parsed = DomainEventEnvelopeSchema.safeParse(value);
  if (!parsed.success || parsed.data.event_type !== 'strategy.keyword_import.requested.v1') {
    throw new KeywordImportWorkerError('Keyword import event is invalid');
  }
  const data = parsed.data.data;
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    parsed.data.aggregate.type !== 'keyword_import_job' ||
    parsed.data.aggregate.id !== data['import_job_id'] ||
    typeof data['keyword_set_id'] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      data['keyword_set_id'],
    )
  ) {
    throw new KeywordImportWorkerError('Keyword import event is invalid');
  }
  return Object.freeze({
    eventId: parsed.data.event_id,
    importJobId: parsed.data.aggregate.id,
    keywordSetId: data['keyword_set_id'],
    occurredAt: parsed.data.occurred_at,
    tenantId: parsed.data.tenant.id,
  });
}

export class KeywordImportWorkerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'KeywordImportWorkerError';
  }
}
