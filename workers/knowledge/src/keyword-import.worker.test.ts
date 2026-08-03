import type { CommitKeywordImportRequest } from '@geo-content-os/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { KeywordImportEvent } from './keyword-import.event.js';
import {
  KeywordImportWorker,
  type KeywordImportCandidate,
  type KeywordImportStorePort,
} from './keyword-import.worker.js';

const options: CommitKeywordImportRequest = {
  platform_scope: ['official_site'],
  priority: 50,
  selected_page_types: ['服务页'],
  selected_source_intents: ['本地搜索'],
  status: 'disabled',
};

describe('keyword import worker', () => {
  it('processes bounded batches and completes the durable job', async () => {
    const batches = [[candidate(5)], [candidate(6)], []];
    const store = fakeStore({
      nextBatch: vi.fn(async () => batches.shift() ?? []),
    });
    const result = await new KeywordImportWorker(store, 1).run(event());
    expect(result).toEqual({
      disposition: 'processed',
      importJobId: '10000000-0000-4000-8000-000000000001',
    });
    expect(store.applyBatch).toHaveBeenCalledTimes(2);
    expect(store.complete).toHaveBeenCalledOnce();
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('does not replay a succeeded job', async () => {
    const store = fakeStore({ claim: vi.fn(async () => 'already_processed' as const) });
    await expect(new KeywordImportWorker(store).run(event())).resolves.toMatchObject({
      disposition: 'already_processed',
    });
    expect(store.nextBatch).not.toHaveBeenCalled();
  });

  it('records terminal failures', async () => {
    const store = fakeStore({
      nextBatch: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    });
    await expect(new KeywordImportWorker(store).run(event())).rejects.toThrow(
      'Keyword import failed',
    );
    expect(store.fail).toHaveBeenCalledWith(expect.any(Object), 'Keyword import failed');
  });
});

function fakeStore(overrides: Partial<KeywordImportStorePort> = {}): KeywordImportStorePort {
  return {
    applyBatch: vi.fn(async () => undefined),
    claim: vi.fn(async () => ({ options })),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    nextBatch: vi.fn(async () => []),
    ...overrides,
  };
}

function candidate(rowNumber: number): KeywordImportCandidate {
  return {
    intents: ['commercial', 'transactional'],
    metadata: { schema_version: 'keyword-import-metadata@1' },
    rowNumber,
    synonyms: [],
    term: `关键词${rowNumber}`,
  };
}

function event(): Record<string, unknown> {
  const parsed: KeywordImportEvent = {
    eventId: '30000000-0000-4000-8000-000000000001',
    importJobId: '10000000-0000-4000-8000-000000000001',
    keywordSetId: '20000000-0000-4000-8000-000000000001',
    occurredAt: '2026-08-03T00:00:00.000Z',
    tenantId: '40000000-0000-4000-8000-000000000001',
  };
  return {
    aggregate: { id: parsed.importJobId, type: 'keyword_import_job' },
    data: { import_job_id: parsed.importJobId, keyword_set_id: parsed.keywordSetId },
    event_id: parsed.eventId,
    event_type: 'strategy.keyword_import.requested.v1',
    occurred_at: parsed.occurredAt,
    tenant: { id: parsed.tenantId },
  };
}
