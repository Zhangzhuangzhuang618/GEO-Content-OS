import type { EmbeddingWorker } from './embedding.worker.js';
import { asIngestError } from './ingest.errors.js';
import { validateKnowledgeIngestEvent } from './ingest.event.js';
import type {
  IngestParserPort,
  IngestStorePort,
  KnowledgeIngestResult,
  MalwareScannerPort,
  MaterialChunkerPort,
  MaterialLoaderPort,
} from './ingest.types.js';

export class KnowledgeIngestWorker {
  public constructor(
    private readonly store: IngestStorePort,
    private readonly loader: MaterialLoaderPort,
    private readonly scanner: MalwareScannerPort,
    private readonly parser: IngestParserPort,
    private readonly chunker: MaterialChunkerPort,
    private readonly embedding: EmbeddingWorker,
    private readonly heartbeatIntervalMs = 10_000,
  ) {
    if (
      !Number.isSafeInteger(heartbeatIntervalMs) ||
      heartbeatIntervalMs < 1_000 ||
      heartbeatIntervalMs > 30_000
    ) {
      throw new TypeError('Knowledge ingest heartbeat interval is invalid');
    }
  }

  public async run(rawEvent: unknown, signal?: AbortSignal): Promise<KnowledgeIngestResult> {
    const event = validateKnowledgeIngestEvent(rawEvent);
    const claimed = await this.store.claim(event);
    if (claimed.kind !== 'claimed') {
      return Object.freeze({
        disposition: claimed.kind,
        sourceDocumentId: event.data.sourceDocumentId,
      });
    }
    const claim = claimed.value;
    try {
      const material = await this.withHeartbeat(event, claim, () =>
        this.loader.load(claim.source, event.data, signal),
      );
      await this.store.markStage(event, claim, 'scan', 15);
      await this.withHeartbeat(event, claim, () => this.scanner.scan(material.body, signal));
      await this.store.markStage(event, claim, 'parse', 35);
      const parsed = await this.withHeartbeat(event, claim, () =>
        this.parser.parse(claim.source, material, `ingest-${event.eventId}`, signal),
      );
      await this.store.markStage(event, claim, 'chunk', 55);
      const chunks = this.chunker.chunk(parsed);
      await this.store.saveChunks(event, claim, chunks);
      await this.store.markStage(event, claim, 'embed', 75);
      const embedded = await this.withHeartbeat(event, claim, () =>
        this.embedding.run({
          requestId: `ingest-${event.eventId}`,
          ...(signal ? { signal } : {}),
          sourceDocumentId: claim.source.id,
          tenantId: event.tenantId,
        }),
      );
      await this.store.markStage(event, claim, 'index', 95);
      await this.store.succeed(event, claim, embedded.modelKey);
      return Object.freeze({
        attempt: claim.attempt,
        disposition: 'processed',
        embedded: embedded.embedded,
        sourceDocumentId: claim.source.id,
      });
    } catch (error) {
      const ingestError = asIngestError(error);
      await this.store.fail(event, claim, ingestError);
      throw ingestError;
    }
  }

  private async withHeartbeat<TResult>(
    event: Parameters<IngestStorePort['heartbeat']>[0],
    claim: Parameters<IngestStorePort['heartbeat']>[1],
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    let heartbeatFailure: unknown;
    let pending = Promise.resolve();
    const timer = setInterval(() => {
      pending = pending
        .then(() => this.store.heartbeat(event, claim))
        .catch((error: unknown) => {
          heartbeatFailure ??= error;
        });
    }, this.heartbeatIntervalMs);
    timer.unref();
    try {
      const result = await operation();
      await pending;
      if (heartbeatFailure) throw heartbeatFailure;
      return result;
    } finally {
      clearInterval(timer);
    }
  }
}
