import { createHash } from 'node:crypto';

import type { EmbeddingConfiguration } from './embedding.config.js';
import { EmbeddingAdapterError, EmbeddingProviderError } from './embedding.errors.js';
import { MockEmbeddingProvider } from './mock-embedding.provider.js';
import {
  EMBEDDING_ADAPTER_VERSION,
  EMBEDDING_DIMENSION,
  type EmbedBatchInput,
  type EmbedBatchResult,
  type EmbeddingAdapter,
  type EmbeddingProvider,
  type EmbeddingUsage,
} from './embedding.types.js';

export function createEmbeddingAdapter(
  configuration: EmbeddingConfiguration,
  provider?: EmbeddingProvider,
): EmbeddingAdapter {
  if (configuration.driver === 'disabled')
    return new DisabledEmbeddingAdapter(configuration.modelKey);
  return new ProviderEmbeddingAdapter(configuration, provider ?? new MockEmbeddingProvider());
}

export class DisabledEmbeddingAdapter implements EmbeddingAdapter {
  public readonly maxBatchSize = 1;
  public constructor(public readonly modelKey: string) {}
  public embedBatch(input: EmbedBatchInput): Promise<EmbedBatchResult> {
    void input;
    return Promise.reject(
      new EmbeddingAdapterError('EMBEDDING_UNAVAILABLE', 'Embedding Adapter is disabled'),
    );
  }
}

export class ProviderEmbeddingAdapter implements EmbeddingAdapter {
  public readonly maxBatchSize: number;
  public readonly modelKey: string;

  public constructor(
    private readonly configuration: EmbeddingConfiguration,
    private readonly provider: EmbeddingProvider,
  ) {
    validateConfiguration(configuration);
    this.maxBatchSize = configuration.maxBatchSize;
    this.modelKey = configuration.modelKey;
    requireIdentifier(provider.providerCode, 'provider code', 120);
    requireIdentifier(provider.providerModelId, 'provider model ID', 160);
  }

  public async embedBatch(input: EmbedBatchInput): Promise<EmbedBatchResult> {
    const inputCharacters = validateInput(input, this.configuration);
    const startedAt = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    let settledUsage: EmbeddingUsage | undefined;
    const cancel = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Embedding timeout'));
    }, this.configuration.timeoutMs);
    const aborted = abortPromise(controller.signal);
    try {
      if (input.signal?.aborted) throw this.cancelled(input, inputCharacters, startedAt);
      const response = await Promise.race([
        this.provider.embedBatch(
          input.inputs.map((item) => Object.freeze({ ...item })),
          input.requestId,
          controller.signal,
        ),
        aborted.promise,
      ]);
      validateResponseUsage(response);
      settledUsage = this.usage(input, inputCharacters, startedAt, {
        inputTokens: response.inputTokens,
        providerRequestId: response.providerRequestId,
        status: 'settled',
      });
      validateEmbeddings(response.embeddings, input);
      return Object.freeze({
        adapterVersion: EMBEDDING_ADAPTER_VERSION,
        dimension: EMBEDDING_DIMENSION,
        embeddings: Object.freeze(
          response.embeddings.map((item) =>
            Object.freeze({ id: item.id, vector: Object.freeze([...item.vector]) }),
          ),
        ),
        usage: settledUsage,
      });
    } catch (error) {
      const unknown = this.usage(input, inputCharacters, startedAt, {
        inputTokens: null,
        providerRequestId: null,
        status: 'unknown',
      });
      if (error instanceof EmbeddingAdapterError) {
        if (error.code !== 'EMBEDDING_RESPONSE_INVALID') throw error;
        throw new EmbeddingAdapterError(error.code, error.message, false, settledUsage ?? unknown, {
          cause: error,
        });
      }
      if (timedOut) {
        throw new EmbeddingAdapterError(
          'EMBEDDING_TIMEOUT',
          'Embedding provider exceeded the configured timeout',
          true,
          unknown,
          { cause: error },
        );
      }
      if (input.signal?.aborted) throw this.cancelled(input, inputCharacters, startedAt, error);
      if (error instanceof EmbeddingProviderError) {
        const settled = Number.isSafeInteger(error.inputTokens) && (error.inputTokens ?? -1) >= 0;
        throw new EmbeddingAdapterError(
          'EMBEDDING_PROVIDER_FAILED',
          'Embedding provider request failed',
          error.retryable,
          this.usage(input, inputCharacters, startedAt, {
            inputTokens: settled ? (error.inputTokens ?? null) : null,
            providerRequestId: safeIdentifier(error.providerRequestId, 200)
              ? (error.providerRequestId ?? null)
              : null,
            status: settled ? 'settled' : 'unknown',
          }),
          { cause: error },
        );
      }
      throw new EmbeddingAdapterError(
        'EMBEDDING_PROVIDER_FAILED',
        'Embedding provider request failed',
        true,
        unknown,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
      aborted.dispose();
      input.signal?.removeEventListener('abort', cancel);
    }
  }

  private cancelled(
    input: EmbedBatchInput,
    inputCharacters: number,
    startedAt: number,
    cause?: unknown,
  ): EmbeddingAdapterError {
    return new EmbeddingAdapterError(
      'EMBEDDING_CANCELLED',
      'Embedding request was cancelled',
      false,
      this.usage(input, inputCharacters, startedAt, {
        inputTokens: null,
        providerRequestId: null,
        status: 'unknown',
      }),
      { cause },
    );
  }

  private usage(
    input: EmbedBatchInput,
    inputCharacters: number,
    startedAt: number,
    values: Pick<EmbeddingUsage, 'inputTokens' | 'providerRequestId' | 'status'>,
  ): EmbeddingUsage {
    return Object.freeze({
      ...values,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      inputCharacters,
      inputCount: input.inputs.length,
      modelKey: this.modelKey,
      providerCode: this.provider.providerCode,
      providerModelId: this.provider.providerModelId,
    });
  }
}

function validateConfiguration(configuration: EmbeddingConfiguration): void {
  if (
    !Number.isSafeInteger(configuration.maxBatchSize) ||
    configuration.maxBatchSize < 1 ||
    configuration.maxBatchSize > 256 ||
    !Number.isSafeInteger(configuration.maxInputCharacters) ||
    configuration.maxInputCharacters < 1 ||
    configuration.maxInputCharacters > 5_000_000 ||
    !Number.isSafeInteger(configuration.timeoutMs) ||
    configuration.timeoutMs < 100 ||
    configuration.timeoutMs > 120_000 ||
    !safeIdentifier(configuration.modelKey, 80)
  ) {
    throw new TypeError('Embedding Adapter configuration is outside supported limits');
  }
}

function validateInput(input: EmbedBatchInput, configuration: EmbeddingConfiguration): number {
  requireIdentifier(input.requestId, 'request ID', 80, 16);
  if (input.inputs.length === 0 || input.inputs.length > configuration.maxBatchSize) {
    throw new EmbeddingAdapterError('EMBEDDING_INVALID_INPUT', 'Embedding batch size is invalid');
  }
  const ids = new Set<string>();
  let characters = 0;
  for (const item of input.inputs) {
    requireIdentifier(item.id, 'input ID', 160);
    if (ids.has(item.id) || !item.text.trim() || !/^[a-f0-9]{64}$/u.test(item.textHash)) {
      throw new EmbeddingAdapterError('EMBEDDING_INVALID_INPUT', 'Embedding input is invalid');
    }
    if (createHash('sha256').update(item.text).digest('hex') !== item.textHash) {
      throw new EmbeddingAdapterError(
        'EMBEDDING_INVALID_INPUT',
        'Embedding text hash does not match',
      );
    }
    ids.add(item.id);
    characters += item.text.length;
  }
  if (characters > configuration.maxInputCharacters) {
    throw new EmbeddingAdapterError('EMBEDDING_INVALID_INPUT', 'Embedding input is too large');
  }
  return characters;
}

function validateResponseUsage(
  response: Awaited<ReturnType<EmbeddingProvider['embedBatch']>>,
): void {
  if (!safeIdentifier(response.providerRequestId, 200)) {
    throw new EmbeddingAdapterError(
      'EMBEDDING_RESPONSE_INVALID',
      'Embedding provider request ID is invalid',
    );
  }
  if (!Number.isSafeInteger(response.inputTokens) || response.inputTokens < 0) {
    throw new EmbeddingAdapterError('EMBEDDING_RESPONSE_INVALID', 'Embedding usage is invalid');
  }
}

function validateEmbeddings(
  embeddings: Awaited<ReturnType<EmbeddingProvider['embedBatch']>>['embeddings'],
  input: EmbedBatchInput,
): void {
  if (embeddings.length !== input.inputs.length) {
    throw new EmbeddingAdapterError('EMBEDDING_RESPONSE_INVALID', 'Embedding count does not match');
  }
  embeddings.forEach((item, index) => {
    if (
      item.id !== input.inputs[index]?.id ||
      item.vector.length !== EMBEDDING_DIMENSION ||
      item.vector.some((value) => !Number.isFinite(value)) ||
      item.vector.every((value) => value === 0)
    ) {
      throw new EmbeddingAdapterError('EMBEDDING_RESPONSE_INVALID', 'Embedding vector is invalid');
    }
  });
}

function requireIdentifier(value: string, name: string, maximum: number, minimum = 1): void {
  if (!safeIdentifier(value, maximum, minimum)) {
    throw new EmbeddingAdapterError('EMBEDDING_INVALID_INPUT', `Embedding ${name} is invalid`);
  }
}

function safeIdentifier(value: string | undefined, maximum: number, minimum = 1): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minimum &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function abortPromise(signal: AbortSignal): { dispose(): void; promise: Promise<never> } {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason ?? new Error('Embedding aborted'));
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  return {
    dispose: () => {
      if (listener) signal.removeEventListener('abort', listener);
    },
    promise,
  };
}
