import { asGenerationFailure, GenerationWorkerError } from './generation.errors.js';
import { validateGenerationEvent } from './generation.event.js';
import type {
  ContentWriterPort,
  GenerationClaim,
  GenerationStorePort,
  GenerationWorkerResult,
  ValidatedGenerationEvent,
  VariantGenerationRun,
} from './generation.types.js';

interface VariantOutcome {
  readonly disposition: 'busy' | 'completed' | 'failed' | 'succeeded';
}

export class ContentGenerationWorker {
  public constructor(
    private readonly store: GenerationStorePort,
    private readonly writer: ContentWriterPort,
    private readonly concurrency = 3,
    private readonly heartbeatIntervalMs = 10_000,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 7) {
      throw new TypeError('Generation concurrency must be between one and seven');
    }
    if (
      !Number.isSafeInteger(heartbeatIntervalMs) ||
      heartbeatIntervalMs < 1_000 ||
      heartbeatIntervalMs > 30_000
    ) {
      throw new TypeError('Generation heartbeat interval is invalid');
    }
  }

  public async run(rawEvent: unknown, signal?: AbortSignal): Promise<GenerationWorkerResult> {
    const event = validateGenerationEvent(rawEvent);
    const claimed = await this.store.claim(event);
    if (claimed.kind !== 'claimed') {
      return Object.freeze({
        disposition: claimed.kind,
        failed: 0,
        packageId: event.data.packageId,
        succeeded: 0,
      });
    }

    let master;
    try {
      master = claimed.value.masterAlreadySucceeded
        ? await this.store.loadMaster(event)
        : await this.generateMaster(event, claimed.value, signal);
    } catch (error) {
      const failure = asGenerationFailure(error);
      if (claimed.value.leaseVersion !== null) {
        await this.store.failMaster(event, claimed.value.leaseVersion, failure);
      }
      await this.store.finalize(event);
      throw error instanceof Error
        ? error
        : new GenerationWorkerError(failure.code, failure.message, { cause: error });
    }

    const outcomes = await concurrentMap(event.data.variantRuns, this.concurrency, (run) =>
      this.generateVariant(event, run, master, signal),
    );
    const packageStatus = await this.store.finalize(event);
    return Object.freeze({
      disposition: 'processed',
      failed: outcomes.filter((outcome) => outcome.disposition === 'failed').length,
      packageId: event.data.packageId,
      packageStatus,
      succeeded: outcomes.filter((outcome) => outcome.disposition === 'succeeded').length,
    });
  }

  private async generateMaster(
    event: ValidatedGenerationEvent,
    claim: GenerationClaim,
    signal?: AbortSignal,
  ) {
    if (claim.leaseVersion === null) throw new Error('Master lease is missing');
    const content = await this.withHeartbeat(
      event,
      event.data.masterRunId,
      claim.leaseVersion,
      () =>
        this.writer.generateMaster({
          requestId: `generation-${event.eventId}-master`,
          ...(signal ? { signal } : {}),
          writerInput: event.data.writerInput,
        }),
    );
    await this.store.saveMaster(event, claim.leaseVersion, content);
    return content;
  }

  private async generateVariant(
    event: ValidatedGenerationEvent,
    run: VariantGenerationRun,
    masterContent: Awaited<ReturnType<ContentWriterPort['generateMaster']>>,
    signal?: AbortSignal,
  ): Promise<VariantOutcome> {
    const claimed = await this.store.claimVariant(event, run);
    if (claimed.kind !== 'claimed') return { disposition: claimed.kind };
    try {
      const content = await this.withHeartbeat(event, run.runId, claimed.value.leaseVersion, () =>
        this.writer.generateVariant({
          masterContent,
          platformCode: run.platformCode,
          requestId: `generation-${event.eventId}-${run.platformCode}`,
          ...(signal ? { signal } : {}),
          writerInput: event.data.writerInput,
        }),
      );
      await this.store.saveVariant(event, claimed.value, content);
      return { disposition: 'succeeded' };
    } catch (error) {
      await this.store.failVariant(event, claimed.value, asGenerationFailure(error));
      return { disposition: 'failed' };
    }
  }

  private async withHeartbeat<TResult>(
    event: ValidatedGenerationEvent,
    runId: string,
    leaseVersion: number,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    let heartbeatFailure: unknown;
    let pending = Promise.resolve();
    const timer = setInterval(() => {
      pending = pending
        .then(() => this.store.heartbeat(event, runId, leaseVersion))
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

async function concurrentMap<TInput, TOutput>(
  inputs: readonly TInput[],
  concurrency: number,
  operation: (input: TInput) => Promise<TOutput>,
): Promise<readonly TOutput[]> {
  const outputs = new Array<TOutput>(inputs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (next < inputs.length) {
      const index = next++;
      outputs[index] = await operation(inputs[index]!);
    }
  });
  await Promise.all(workers);
  return outputs;
}
