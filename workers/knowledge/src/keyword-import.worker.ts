import type { CommitKeywordImportRequest } from '@geo-content-os/contracts';

import {
  KeywordImportWorkerError,
  validateKeywordImportEvent,
  type KeywordImportEvent,
} from './keyword-import.event.js';

export interface KeywordImportCandidate {
  readonly intents: readonly ('informational' | 'commercial' | 'transactional' | 'navigational')[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly rowNumber: number;
  readonly synonyms: readonly string[];
  readonly term: string;
}

export interface KeywordImportClaim {
  readonly options: CommitKeywordImportRequest;
}

export interface KeywordImportStorePort {
  applyBatch(
    event: KeywordImportEvent,
    options: CommitKeywordImportRequest,
    candidates: readonly KeywordImportCandidate[],
  ): Promise<void>;
  claim(event: KeywordImportEvent): Promise<'already_processed' | KeywordImportClaim>;
  complete(event: KeywordImportEvent): Promise<void>;
  fail(event: KeywordImportEvent, message: string): Promise<void>;
  nextBatch(
    event: KeywordImportEvent,
    options: CommitKeywordImportRequest,
    limit: number,
  ): Promise<readonly KeywordImportCandidate[]>;
}

export interface KeywordImportWorkerResult {
  readonly disposition: 'already_processed' | 'processed';
  readonly importJobId: string;
}

export class KeywordImportWorker {
  public constructor(
    private readonly store: KeywordImportStorePort,
    private readonly batchSize = 500,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new TypeError('Keyword import batch size is invalid');
    }
  }

  public async run(value: unknown): Promise<KeywordImportWorkerResult> {
    const event = validateKeywordImportEvent(value);
    const claim = await this.store.claim(event);
    if (claim === 'already_processed') {
      return Object.freeze({ disposition: 'already_processed', importJobId: event.importJobId });
    }
    try {
      while (true) {
        const candidates = await this.store.nextBatch(event, claim.options, this.batchSize);
        if (candidates.length === 0) break;
        await this.store.applyBatch(event, claim.options, candidates);
      }
      await this.store.complete(event);
      return Object.freeze({ disposition: 'processed', importJobId: event.importJobId });
    } catch (error) {
      const normalized =
        error instanceof KeywordImportWorkerError
          ? error
          : new KeywordImportWorkerError('Keyword import failed');
      await this.store.fail(event, normalized.message);
      throw normalized;
    }
  }
}
