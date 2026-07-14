import { createHash } from 'node:crypto';

import type { RerankConfiguration } from './rerank.config.js';
import { RerankAdapterError, RerankProviderError } from './rerank.errors.js';
import { MockRerankProvider } from './mock-rerank.provider.js';
import {
  RERANK_ADAPTER_VERSION,
  type RerankAdapter,
  type RerankInput,
  type RerankProvider,
  type RerankResult,
  type RerankUsage,
} from './rerank.types.js';

export function createRerankAdapter(
  configuration: RerankConfiguration,
  provider?: RerankProvider,
): RerankAdapter {
  validateConfiguration(configuration);
  if (configuration.driver === 'disabled') return new DisabledRerankAdapter(configuration.modelKey);
  return new ProviderRerankAdapter(configuration, provider ?? new MockRerankProvider());
}

export class DisabledRerankAdapter implements RerankAdapter {
  public constructor(public readonly modelKey: string) {
    requireIdentifier(modelKey, 'model key', 80);
  }
  public rerank(input: RerankInput): Promise<RerankResult> {
    void input;
    return Promise.reject(
      new RerankAdapterError('RERANK_UNAVAILABLE', 'Rerank Adapter is disabled'),
    );
  }
}

export class ProviderRerankAdapter implements RerankAdapter {
  public readonly modelKey: string;

  public constructor(
    private readonly configuration: RerankConfiguration,
    private readonly provider: RerankProvider,
  ) {
    validateConfiguration(configuration);
    this.modelKey = configuration.modelKey;
    requireIdentifier(provider.providerCode, 'provider code', 120);
    requireIdentifier(provider.providerModelId, 'provider model ID', 160);
  }

  public async rerank(input: RerankInput): Promise<RerankResult> {
    const validated = validateInput(input, this.configuration);
    const inputCharacters = validated.inputCharacters;
    const startedAt = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    let settledUsage: RerankUsage | undefined;
    const cancel = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Rerank timeout'));
    }, this.configuration.timeoutMs);
    const aborted = abortPromise(controller.signal);
    try {
      if (input.signal?.aborted) throw this.cancelled(input, inputCharacters, startedAt);
      const response = await Promise.race([
        this.provider.rerank(
          validated.query,
          input.documents.map((document) => Object.freeze({ ...document })),
          input.requestId,
          controller.signal,
        ),
        aborted.promise,
      ]);
      validateUsage(response.inputTokens, response.providerRequestId);
      settledUsage = this.usage(input, inputCharacters, startedAt, {
        inputTokens: response.inputTokens,
        providerRequestId: response.providerRequestId,
        status: 'settled',
      });
      const items = validateAndSortItems(response.items, input);
      return Object.freeze({
        adapterVersion: RERANK_ADAPTER_VERSION,
        items: Object.freeze(items.slice(0, input.topK)),
        usage: settledUsage,
      });
    } catch (error) {
      const unknown = this.usage(input, inputCharacters, startedAt, {
        inputTokens: null,
        providerRequestId: null,
        status: 'unknown',
      });
      if (error instanceof RerankAdapterError) {
        if (error.code !== 'RERANK_RESPONSE_INVALID') throw error;
        throw new RerankAdapterError(error.code, error.message, false, settledUsage ?? unknown, {
          cause: error,
        });
      }
      if (timedOut) {
        throw new RerankAdapterError(
          'RERANK_TIMEOUT',
          'Rerank provider exceeded the configured timeout',
          true,
          unknown,
          { cause: error },
        );
      }
      if (input.signal?.aborted) throw this.cancelled(input, inputCharacters, startedAt, error);
      if (error instanceof RerankProviderError) {
        const settled = Number.isSafeInteger(error.inputTokens) && (error.inputTokens ?? -1) >= 0;
        throw new RerankAdapterError(
          'RERANK_PROVIDER_FAILED',
          'Rerank provider request failed',
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
      throw new RerankAdapterError(
        'RERANK_PROVIDER_FAILED',
        'Rerank provider request failed',
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
    input: RerankInput,
    inputCharacters: number,
    startedAt: number,
    cause?: unknown,
  ): RerankAdapterError {
    return new RerankAdapterError(
      'RERANK_CANCELLED',
      'Rerank request was cancelled',
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
    input: RerankInput,
    inputCharacters: number,
    startedAt: number,
    values: Pick<RerankUsage, 'inputTokens' | 'providerRequestId' | 'status'>,
  ): RerankUsage {
    return Object.freeze({
      ...values,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      inputCharacters,
      inputDocuments: input.documents.length,
      modelKey: this.modelKey,
      providerCode: this.provider.providerCode,
      providerModelId: this.provider.providerModelId,
    });
  }
}

function validateConfiguration(configuration: RerankConfiguration): void {
  if (
    (configuration.driver !== 'disabled' && configuration.driver !== 'mock') ||
    !Number.isSafeInteger(configuration.maxDocuments) ||
    configuration.maxDocuments < 1 ||
    configuration.maxDocuments > 100 ||
    !Number.isSafeInteger(configuration.maxInputCharacters) ||
    configuration.maxInputCharacters < 1 ||
    configuration.maxInputCharacters > 1_000_000 ||
    !Number.isSafeInteger(configuration.timeoutMs) ||
    configuration.timeoutMs < 100 ||
    configuration.timeoutMs > 120_000 ||
    !safeIdentifier(configuration.modelKey, 80)
  ) {
    throw new TypeError('Rerank Adapter configuration is outside supported limits');
  }
}

function validateInput(
  input: RerankInput,
  configuration: RerankConfiguration,
): { readonly inputCharacters: number; readonly query: string } {
  const query = input.query.normalize('NFC').trim().replace(/\s+/gu, ' ');
  requireIdentifier(input.requestId, 'request ID', 80, 16);
  if (query.length < 2 || query.length > 500) {
    throw new RerankAdapterError('RERANK_INVALID_INPUT', 'Rerank query is invalid');
  }
  if (
    input.documents.length === 0 ||
    input.documents.length > configuration.maxDocuments ||
    !Number.isSafeInteger(input.topK) ||
    input.topK < 1 ||
    input.topK > input.documents.length
  ) {
    throw new RerankAdapterError(
      'RERANK_INVALID_INPUT',
      'Rerank document count or topK is invalid',
    );
  }
  const ids = new Set<string>();
  let characters = query.length;
  for (const document of input.documents) {
    requireIdentifier(document.id, 'document ID', 160);
    if (
      ids.has(document.id) ||
      !document.text.trim() ||
      document.text.length > 100_000 ||
      !/^[a-f0-9]{64}$/u.test(document.textHash) ||
      createHash('sha256').update(document.text).digest('hex') !== document.textHash ||
      (document.title !== undefined &&
        (!document.title.trim() ||
          document.title.length > 500 ||
          hasControlCharacter(document.title)))
    ) {
      throw new RerankAdapterError('RERANK_INVALID_INPUT', 'Rerank document is invalid');
    }
    ids.add(document.id);
    characters += document.text.length + (document.title?.length ?? 0);
  }
  if (characters > configuration.maxInputCharacters) {
    throw new RerankAdapterError('RERANK_INVALID_INPUT', 'Rerank input is too large');
  }
  return { inputCharacters: characters, query };
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function validateUsage(inputTokens: number, providerRequestId: string): void {
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !safeIdentifier(providerRequestId, 200)
  ) {
    throw new RerankAdapterError('RERANK_RESPONSE_INVALID', 'Rerank provider usage is invalid');
  }
}

function validateAndSortItems(
  items: Awaited<ReturnType<RerankProvider['rerank']>>['items'],
  input: RerankInput,
): readonly Readonly<{ id: string; score: number }>[] {
  if (items.length !== input.documents.length) {
    throw new RerankAdapterError('RERANK_RESPONSE_INVALID', 'Rerank item count does not match');
  }
  const expected = new Map(input.documents.map((document, index) => [document.id, index]));
  const seen = new Set<string>();
  for (const item of items) {
    if (
      !expected.has(item.id) ||
      seen.has(item.id) ||
      !Number.isFinite(item.score) ||
      item.score < 0 ||
      item.score > 1
    ) {
      throw new RerankAdapterError('RERANK_RESPONSE_INVALID', 'Rerank item is invalid');
    }
    seen.add(item.id);
  }
  return [...items]
    .sort(
      (left, right) => right.score - left.score || expected.get(left.id)! - expected.get(right.id)!,
    )
    .map((item) => Object.freeze({ id: item.id, score: item.score }));
}

function requireIdentifier(value: string, name: string, maximum: number, minimum = 1): void {
  if (!safeIdentifier(value, maximum, minimum)) {
    throw new RerankAdapterError('RERANK_INVALID_INPUT', `Rerank ${name} is invalid`);
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
    listener = () => reject(signal.reason ?? new Error('Rerank aborted'));
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
