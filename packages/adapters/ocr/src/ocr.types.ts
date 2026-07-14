export const OCR_ADAPTER_VERSION = 'ocr-adapter/1.0.0' as const;

export const OCR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type OcrMimeType = (typeof OCR_MIME_TYPES)[number];

export interface OcrPageInput {
  readonly body: Uint8Array;
  readonly contentHash: string;
  readonly mimeType: OcrMimeType;
  readonly pageNumber: number;
}

export interface OcrRecognizeInput {
  readonly languageHints?: readonly string[];
  readonly pages: readonly OcrPageInput[];
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface OcrBoundingBox {
  /** Normalized left coordinate in the inclusive range 0..1. */
  readonly x: number;
  /** Normalized top coordinate in the inclusive range 0..1. */
  readonly y: number;
  /** Normalized positive width; x + width must not exceed 1. */
  readonly width: number;
  /** Normalized positive height; y + height must not exceed 1. */
  readonly height: number;
}

export type OcrBlockKind = 'line' | 'paragraph' | 'table_cell' | 'word';

export interface OcrTextBlock {
  readonly boundingBox: OcrBoundingBox;
  readonly confidence: number;
  readonly kind: OcrBlockKind;
  readonly readingOrder: number;
  readonly text: string;
}

export interface OcrPageResult {
  readonly blocks: readonly OcrTextBlock[];
  readonly height: number;
  readonly pageNumber: number;
  readonly text: string;
  readonly width: number;
}

export interface OcrUsage {
  readonly billablePages: number | null;
  readonly durationMs: number;
  readonly inputBytes: number;
  readonly inputPages: number;
  readonly modelId: string;
  readonly providerCode: string;
  readonly providerRequestId: string | null;
  readonly status: 'settled' | 'unknown';
  readonly unit: 'page';
}

export interface OcrRecognitionResult {
  readonly adapterVersion: typeof OCR_ADAPTER_VERSION;
  readonly pages: readonly OcrPageResult[];
  readonly text: string;
  readonly textHash: string;
  readonly usage: OcrUsage;
}

export interface OcrProviderRequest {
  readonly languageHints: readonly string[];
  readonly pages: readonly OcrPageInput[];
  readonly requestId: string;
}

export interface OcrProviderTextBlock {
  readonly boundingBox: OcrBoundingBox;
  readonly confidence: number;
  readonly kind?: OcrBlockKind;
  readonly readingOrder: number;
  readonly text: string;
}

export interface OcrProviderPage {
  readonly blocks: readonly OcrProviderTextBlock[];
  readonly height: number;
  readonly pageNumber: number;
  readonly width: number;
}

export interface OcrProviderResponse {
  readonly billablePages: number;
  readonly pages: readonly OcrProviderPage[];
  readonly providerRequestId: string;
}

export interface OcrProvider {
  readonly modelId: string;
  readonly providerCode: string;
  recognize(request: OcrProviderRequest, signal: AbortSignal): Promise<OcrProviderResponse>;
}

export interface OcrAdapter {
  recognize(input: OcrRecognizeInput): Promise<OcrRecognitionResult>;
}
