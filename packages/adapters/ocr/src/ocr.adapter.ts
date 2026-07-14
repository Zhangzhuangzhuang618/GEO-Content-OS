import { createHash } from 'node:crypto';

import type { OcrConfiguration } from './ocr.config.js';
import { OcrAdapterError, type OcrAdapterErrorCode, OcrProviderError } from './ocr.errors.js';
import { MockOcrProvider } from './mock-ocr.provider.js';
import {
  OCR_ADAPTER_VERSION,
  type OcrAdapter,
  type OcrPageInput,
  type OcrPageResult,
  type OcrProvider,
  type OcrProviderPage,
  type OcrRecognitionResult,
  type OcrRecognizeInput,
  type OcrUsage,
} from './ocr.types.js';

export function createOcrAdapter(
  configuration: OcrConfiguration,
  provider?: OcrProvider,
): OcrAdapter {
  if (configuration.driver === 'disabled') return new DisabledOcrAdapter();
  return new ProviderOcrAdapter(configuration, provider ?? new MockOcrProvider());
}

export class DisabledOcrAdapter implements OcrAdapter {
  public recognize(input: OcrRecognizeInput): Promise<OcrRecognitionResult> {
    void input;
    return Promise.reject(
      new OcrAdapterError('OCR_UNAVAILABLE', 'OCR Adapter is disabled', { retryable: false }),
    );
  }
}

export class ProviderOcrAdapter implements OcrAdapter {
  public constructor(
    private readonly configuration: OcrConfiguration,
    private readonly provider: OcrProvider,
  ) {
    validateConfiguration(configuration);
    requireSafeIdentifier(provider.providerCode, 'providerCode');
    requireSafeIdentifier(provider.modelId, 'modelId');
  }

  public async recognize(input: OcrRecognizeInput): Promise<OcrRecognitionResult> {
    const inputBytes = validateInput(input, this.configuration);
    const startedAt = performance.now();
    const controller = new AbortController();
    const abortRejection = createAbortRejection(controller.signal);
    let timedOut = false;
    let settledUsage: OcrUsage | undefined;
    const cancel = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('OCR timeout'));
    }, this.configuration.timeoutMs);

    try {
      if (input.signal?.aborted) {
        throw cancelledError(this.unknownUsage(input, inputBytes, startedAt));
      }
      const response = await Promise.race([
        this.provider.recognize(
          {
            languageHints: Object.freeze([...(input.languageHints ?? [])]),
            pages: clonePages(input.pages),
            requestId: input.requestId,
          },
          controller.signal,
        ),
        abortRejection.promise,
      ]);
      requireSafeIdentifier(
        response.providerRequestId,
        'providerRequestId',
        200,
        1,
        'OCR_RESPONSE_INVALID',
      );
      if (
        !Number.isSafeInteger(response.billablePages) ||
        response.billablePages < 0 ||
        response.billablePages > 1_000_000
      ) {
        throw new OcrAdapterError('OCR_RESPONSE_INVALID', 'OCR provider returned invalid usage');
      }
      settledUsage = this.usage(input, inputBytes, startedAt, {
        billablePages: response.billablePages,
        providerRequestId: response.providerRequestId,
        status: 'settled',
      });
      const pages = validateResponse(response.pages, input.pages, this.configuration.maxCharacters);
      const text = pages
        .map((page) => page.text)
        .filter(Boolean)
        .join('\n\n');
      if (!text) {
        throw new OcrAdapterError('OCR_RESPONSE_INVALID', 'OCR provider returned no text');
      }
      return Object.freeze({
        adapterVersion: OCR_ADAPTER_VERSION,
        pages: Object.freeze(pages),
        text,
        textHash: createHash('sha256').update(text).digest('hex'),
        usage: settledUsage,
      });
    } catch (error) {
      const unknownUsage = this.unknownUsage(input, inputBytes, startedAt);
      if (error instanceof OcrAdapterError) {
        if (error.code !== 'OCR_RESPONSE_INVALID') throw error;
        throw new OcrAdapterError(error.code, error.message, {
          cause: error,
          retryable: false,
          usage: settledUsage ?? unknownUsage,
        });
      }
      if (timedOut) {
        throw new OcrAdapterError('OCR_TIMEOUT', 'OCR provider exceeded the configured timeout', {
          cause: error,
          retryable: true,
          usage: unknownUsage,
        });
      }
      if (input.signal?.aborted) throw cancelledError(unknownUsage, error);
      if (error instanceof OcrProviderError) {
        const hasSettledUsage =
          Number.isSafeInteger(error.billablePages) &&
          (error.billablePages ?? -1) >= 0 &&
          (error.billablePages ?? Number.POSITIVE_INFINITY) <= 1_000_000;
        const usage = this.usage(input, inputBytes, startedAt, {
          billablePages: hasSettledUsage ? (error.billablePages ?? null) : null,
          providerRequestId: isSafeIdentifier(error.providerRequestId, 200)
            ? (error.providerRequestId ?? null)
            : null,
          status: hasSettledUsage ? 'settled' : 'unknown',
        });
        throw new OcrAdapterError('OCR_PROVIDER_FAILED', 'OCR provider request failed', {
          cause: error,
          retryable: error.retryable,
          usage,
        });
      }
      throw new OcrAdapterError('OCR_PROVIDER_FAILED', 'OCR provider request failed', {
        cause: error,
        retryable: true,
        usage: unknownUsage,
      });
    } finally {
      clearTimeout(timer);
      abortRejection.dispose();
      input.signal?.removeEventListener('abort', cancel);
    }
  }

  private unknownUsage(input: OcrRecognizeInput, inputBytes: number, startedAt: number): OcrUsage {
    return this.usage(input, inputBytes, startedAt, {
      billablePages: null,
      providerRequestId: null,
      status: 'unknown',
    });
  }

  private usage(
    input: OcrRecognizeInput,
    inputBytes: number,
    startedAt: number,
    providerUsage: Pick<OcrUsage, 'billablePages' | 'providerRequestId' | 'status'>,
  ): OcrUsage {
    return Object.freeze({
      ...providerUsage,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      inputBytes,
      inputPages: input.pages.length,
      modelId: this.provider.modelId,
      providerCode: this.provider.providerCode,
      unit: 'page',
    });
  }
}

function validateConfiguration(configuration: OcrConfiguration): void {
  const limits = [
    [configuration.maxBytes, 1, 25 * 1_024 * 1_024],
    [configuration.maxCharacters, 1, 5_000_000],
    [configuration.maxPages, 1, 100],
    [configuration.timeoutMs, 100, 60_000],
  ] as const;
  if (
    limits.some(
      ([value, minimum, maximum]) =>
        !Number.isSafeInteger(value) || value < minimum || value > maximum,
    )
  ) {
    throw new TypeError('OCR Adapter configuration is outside supported limits');
  }
}

function validateInput(input: OcrRecognizeInput, configuration: OcrConfiguration): number {
  requireSafeIdentifier(input.requestId, 'requestId', 80, 16);
  if (input.pages.length === 0 || input.pages.length > configuration.maxPages) {
    throw new OcrAdapterError(
      'OCR_INVALID_INPUT',
      'OCR page count is outside the configured limit',
    );
  }
  const languageHints = input.languageHints ?? [];
  if (
    languageHints.length > 8 ||
    languageHints.some(
      (value) => value.length > 35 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value),
    )
  ) {
    throw new OcrAdapterError('OCR_INVALID_INPUT', 'OCR language hints are invalid');
  }
  let previousPage = 0;
  let inputBytes = 0;
  for (const page of input.pages) {
    if (!Number.isSafeInteger(page.pageNumber) || page.pageNumber <= previousPage) {
      throw new OcrAdapterError(
        'OCR_INVALID_INPUT',
        'OCR page numbers must be positive, unique, and ascending',
      );
    }
    previousPage = page.pageNumber;
    validateImage(page);
    inputBytes += page.body.byteLength;
    if (inputBytes > configuration.maxBytes) {
      throw new OcrAdapterError('OCR_INVALID_INPUT', 'OCR input exceeds the configured size limit');
    }
  }
  return inputBytes;
}

function clonePages(pages: readonly OcrPageInput[]): readonly OcrPageInput[] {
  return Object.freeze(
    pages.map((page) =>
      Object.freeze({
        ...page,
        body: Uint8Array.from(page.body),
      }),
    ),
  );
}

function validateImage(page: OcrPageInput): void {
  if (page.body.byteLength === 0) {
    throw new OcrAdapterError('OCR_INVALID_INPUT', 'OCR image is empty');
  }
  if (!/^[a-f0-9]{64}$/u.test(page.contentHash)) {
    throw new OcrAdapterError('OCR_INVALID_INPUT', 'OCR content hash is invalid');
  }
  const actualHash = createHash('sha256').update(page.body).digest('hex');
  if (actualHash !== page.contentHash || !signatureMatches(page)) {
    throw new OcrAdapterError(
      'OCR_INVALID_INPUT',
      'OCR image signature, MIME, or content hash does not match',
    );
  }
}

function signatureMatches(page: OcrPageInput): boolean {
  const body = page.body;
  if (page.mimeType === 'image/png') {
    return Buffer.from(body.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (page.mimeType === 'image/jpeg') {
    return body[0] === 0xff && body[1] === 0xd8 && body.at(-2) === 0xff && body.at(-1) === 0xd9;
  }
  return (
    Buffer.from(body.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(body.subarray(8, 12)).toString('ascii') === 'WEBP'
  );
}

function validateResponse(
  providerPages: readonly OcrProviderPage[],
  inputPages: readonly OcrPageInput[],
  maxCharacters: number,
): OcrPageResult[] {
  if (providerPages.length !== inputPages.length) {
    throw new OcrAdapterError(
      'OCR_RESPONSE_INVALID',
      'OCR provider page count does not match input',
    );
  }
  let totalCharacters = 0;
  return providerPages.map((page, pageIndex) => {
    if (page.pageNumber !== inputPages[pageIndex]?.pageNumber) {
      throw new OcrAdapterError(
        'OCR_RESPONSE_INVALID',
        'OCR provider page order does not match input',
      );
    }
    if (
      !Number.isSafeInteger(page.width) ||
      !Number.isSafeInteger(page.height) ||
      page.width <= 0 ||
      page.height <= 0 ||
      page.width > 100_000 ||
      page.height > 100_000 ||
      page.blocks.length > 20_000
    ) {
      throw new OcrAdapterError('OCR_RESPONSE_INVALID', 'OCR provider page geometry is invalid');
    }
    const orders = new Set<number>();
    const blocks = page.blocks.map((block) => {
      const text = typeof block.text === 'string' ? normalizeText(block.text) : '';
      if (
        !text ||
        !Number.isFinite(block.confidence) ||
        block.confidence < 0 ||
        block.confidence > 1 ||
        !Number.isSafeInteger(block.readingOrder) ||
        block.readingOrder < 0 ||
        orders.has(block.readingOrder) ||
        (block.kind !== undefined &&
          !['line', 'paragraph', 'table_cell', 'word'].includes(block.kind)) ||
        !validBox(block.boundingBox)
      ) {
        throw new OcrAdapterError('OCR_RESPONSE_INVALID', 'OCR provider text block is invalid');
      }
      orders.add(block.readingOrder);
      totalCharacters += text.length;
      if (totalCharacters > maxCharacters) {
        throw new OcrAdapterError('OCR_RESPONSE_INVALID', 'OCR output exceeds the character limit');
      }
      return Object.freeze({
        boundingBox: Object.freeze({ ...block.boundingBox }),
        confidence: block.confidence,
        kind: block.kind ?? 'line',
        readingOrder: block.readingOrder,
        text,
      });
    });
    blocks.sort((left, right) => left.readingOrder - right.readingOrder);
    return Object.freeze({
      blocks: Object.freeze(blocks),
      height: page.height,
      pageNumber: page.pageNumber,
      text: blocks.map((block) => block.text).join('\n'),
      width: page.width,
    });
  });
}

function validBox(
  box: { x: number; y: number; width: number; height: number } | null | undefined,
): boolean {
  return (
    box !== null &&
    box !== undefined &&
    [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1 + Number.EPSILON &&
    box.y + box.height <= 1 + Number.EPSILON
  );
}

function normalizeText(value: string): string {
  return stripUnsafeControls(value)
    .normalize('NFC')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(/[\t ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .trim();
}

function stripUnsafeControls(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('');
}

function requireSafeIdentifier(
  value: string,
  name: string,
  maximum = 120,
  minimum = 1,
  errorCode: OcrAdapterErrorCode = 'OCR_INVALID_INPUT',
): void {
  if (!isSafeIdentifier(value, maximum, minimum)) {
    throw new OcrAdapterError(errorCode, `${name} is invalid`);
  }
}

function isSafeIdentifier(
  value: string | undefined,
  maximum: number,
  minimum = 1,
): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minimum &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function createAbortRejection(signal: AbortSignal): {
  readonly dispose: () => void;
  readonly promise: Promise<never>;
} {
  let rejectOnAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(signal.reason ?? new Error('OCR request aborted'));
    if (signal.aborted) rejectOnAbort();
    else signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  return {
    dispose: () => {
      if (rejectOnAbort) signal.removeEventListener('abort', rejectOnAbort);
    },
    promise,
  };
}

function cancelledError(usage: OcrUsage, cause?: unknown): OcrAdapterError {
  return new OcrAdapterError('OCR_CANCELLED', 'OCR request was cancelled', {
    cause,
    retryable: false,
    usage,
  });
}
