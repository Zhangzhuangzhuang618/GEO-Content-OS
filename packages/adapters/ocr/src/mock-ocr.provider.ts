import { OcrProviderError } from './ocr.errors.js';
import type {
  OcrProvider,
  OcrProviderPage,
  OcrProviderRequest,
  OcrProviderResponse,
} from './ocr.types.js';

export interface MockOcrProviderOptions {
  readonly fail?: boolean;
  readonly latencyMs?: number;
  readonly retryableFailure?: boolean;
  readonly textByContentHash?: Readonly<Record<string, string>>;
}

export class MockOcrProvider implements OcrProvider {
  public readonly modelId = 'mock-ocr-v1';
  public readonly providerCode = 'mock';

  public constructor(private readonly options: MockOcrProviderOptions = {}) {
    if (
      options.latencyMs !== undefined &&
      (!Number.isSafeInteger(options.latencyMs) ||
        options.latencyMs < 0 ||
        options.latencyMs > 60_000)
    ) {
      throw new TypeError('Mock OCR latency must be an integer between 0 and 60000');
    }
  }

  public async recognize(
    request: OcrProviderRequest,
    signal: AbortSignal,
  ): Promise<OcrProviderResponse> {
    await abortableDelay(this.options.latencyMs ?? 0, signal);
    if (this.options.fail) {
      throw new OcrProviderError('Mock OCR provider failure', {
        ...(this.options.retryableFailure === undefined
          ? {}
          : { retryable: this.options.retryableFailure }),
      });
    }
    const pages: OcrProviderPage[] = request.pages.map((page) => {
      const configured = this.options.textByContentHash?.[page.contentHash];
      const text = configured ?? `Mock OCR ${page.contentHash.slice(0, 12)}`;
      return {
        blocks: text.trim()
          ? [
              {
                boundingBox: { height: 0.8, width: 0.8, x: 0.1, y: 0.1 },
                confidence: 1,
                kind: 'paragraph',
                readingOrder: 0,
                text,
              },
            ]
          : [],
        height: 1_000,
        pageNumber: page.pageNumber,
        width: 1_000,
      };
    });
    return {
      billablePages: pages.length,
      pages,
      providerRequestId: `mock-${request.requestId}`,
    };
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('OCR request aborted'));
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const complete = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(complete, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('OCR request aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
