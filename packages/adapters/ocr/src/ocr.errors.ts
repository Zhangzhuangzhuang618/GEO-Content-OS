import type { OcrUsage } from './ocr.types.js';

export type OcrAdapterErrorCode =
  | 'OCR_CANCELLED'
  | 'OCR_INVALID_INPUT'
  | 'OCR_PROVIDER_FAILED'
  | 'OCR_RESPONSE_INVALID'
  | 'OCR_TIMEOUT'
  | 'OCR_UNAVAILABLE';

export class OcrAdapterError extends Error {
  public readonly code: OcrAdapterErrorCode;
  public readonly retryable: boolean;
  public readonly usage?: OcrUsage;

  public constructor(
    code: OcrAdapterErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly retryable?: boolean;
      readonly usage?: OcrUsage;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OcrAdapterError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.usage) this.usage = options.usage;
  }
}

export class OcrProviderError extends Error {
  public readonly billablePages?: number;
  public readonly providerRequestId?: string;
  public readonly retryable: boolean;

  public constructor(
    message: string,
    options: {
      readonly billablePages?: number;
      readonly cause?: unknown;
      readonly providerRequestId?: string;
      readonly retryable?: boolean;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OcrProviderError';
    this.retryable = options.retryable ?? true;
    if (options.billablePages !== undefined) this.billablePages = options.billablePages;
    if (options.providerRequestId !== undefined) this.providerRequestId = options.providerRequestId;
  }
}
