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
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
      throw new TypeError('Generation concurrency must be between one and eight');
    }
    if (
      !Number.isSafeInteger(heartbeatIntervalMs) ||
      heartbeatIntervalMs < 1_000 ||
      heartbeatIntervalMs > 30_000
    ) {
      throw new TypeError('Generation heartbeat interval is invalid');
    }
  }

  public async run(
    rawEvent: unknown,
    signal?: AbortSignal,
    attempt = { attempt: 1, maxAttempts: 1 },
  ): Promise<GenerationWorkerResult> {
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
      logGenerationFailure(event, event.data.masterRunId, null, 'master', error, failure);
      if (claimed.value.leaseVersion !== null) {
        if (failure.retryable && attempt.attempt < attempt.maxAttempts) {
          await this.store.retryMaster(event, claimed.value.leaseVersion, failure);
        } else {
          await this.store.failMaster(event, claimed.value.leaseVersion, failure);
        }
      }
      if (!failure.retryable || attempt.attempt >= attempt.maxAttempts) {
        await this.store.finalize(event);
      }
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
      () => {
        const generate =
          usesOfficialSiteDirectFlow(event.data.writerInput) &&
          this.writer.generateOfficialSiteMaster
            ? this.writer.generateOfficialSiteMaster.bind(this.writer)
            : this.writer.generateMaster.bind(this.writer);
        return generate({
          context: writerContext(event, event.data.masterRunId, null),
          requestId: `generation-${event.eventId}-master`,
          ...(event.data.revision ? { revision: event.data.revision } : {}),
          ...(signal ? { signal } : {}),
          writerInput: event.data.writerInput,
        });
      },
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
      const content = await this.withHeartbeat(event, run.runId, claimed.value.leaseVersion, () => {
        const direct =
          run.platformCode === 'official_site' &&
          usesOfficialSiteDirectFlow(event.data.writerInput) &&
          this.writer.generateOfficialSiteVariant;
        if (direct) {
          return direct.call(this.writer, {
            context: writerContext(event, run.runId, run.variantId),
            masterContent,
            platformCode: 'official_site',
            requestId: `generation-${event.eventId}-${run.platformCode}`,
            ...(signal ? { signal } : {}),
            writerInput: event.data.writerInput,
          });
        }
        return this.writer.generateVariant({
          context: writerContext(event, run.runId, run.variantId),
          masterContent,
          platformCode: run.platformCode,
          requestId: `generation-${event.eventId}-${run.platformCode}`,
          ...(signal ? { signal } : {}),
          writerInput: event.data.writerInput,
        });
      });
      await this.store.saveVariant(event, claimed.value, content);
      return { disposition: 'succeeded' };
    } catch (error) {
      const failure = asGenerationFailure(error);
      logGenerationFailure(event, run.runId, run.variantId, 'variant', error, failure);
      await this.store.failVariant(event, claimed.value, failure);
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

function usesOfficialSiteDirectFlow(writerInput: ValidatedGenerationEvent['data']['writerInput']) {
  const brief = writerInput['brief'];
  if (!isRecord(brief)) return false;
  const constraints = brief['constraints'];
  if (isRecord(constraints) && constraints['official_site_direct'] === true) return true;
  const platforms = brief['platform_codes'];
  return Array.isArray(platforms) && platforms.length === 1 && platforms[0] === 'official_site';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writerContext(event: ValidatedGenerationEvent, runId: string, variantId: string | null) {
  return Object.freeze({
    batchKey: event.eventId,
    inputHash: event.data.inputHash,
    modelKey: event.data.modelKey,
    modelPolicy: event.data.modelPolicy,
    packageId: event.data.packageId,
    projectId: event.data.projectId,
    promptVersionId: event.data.promptVersionId,
    runId,
    skillVersion: event.data.skillVersion,
    skillName: 'content-writer',
    tenantId: event.tenantId,
    variantId,
    workspaceId: event.data.workspaceId,
  });
}

function logGenerationFailure(
  event: ValidatedGenerationEvent,
  runId: string,
  variantId: string | null,
  stage: 'master' | 'variant',
  error: unknown,
  failure: ReturnType<typeof asGenerationFailure>,
): void {
  console.error('AI content generation failed', {
    error_code: failure.code,
    error_message: safeDiagnosticMessage(error),
    error_type: error instanceof Error ? error.name : typeof error,
    event_id: event.eventId,
    generation_run_id: runId,
    package_id: event.data.packageId,
    request_id: event.data.requestId,
    stage,
    tenant_id: event.tenantId,
    variant_id: variantId,
  });
}

function safeDiagnosticMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Non-Error generation failure';
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/giu, 'sk-[REDACTED]')
    .replace(/\b(password|passwd|api[_ -]?key)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 500);
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
