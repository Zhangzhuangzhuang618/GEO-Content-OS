export interface ImageProviderConfiguration {
  readonly accountId: string;
  readonly apiToken: string;
  readonly generationModel: string;
  readonly inspectionModel: string;
  readonly timeoutMs: number;
}

export interface ImageGenerationRequest {
  readonly prompt: string;
  readonly requestId: string;
  readonly seed: number;
  readonly signal?: AbortSignal;
  readonly steps: number;
}

export interface ImageGenerationResult {
  readonly body: Uint8Array;
  readonly mimeType: 'image/jpeg' | 'image/png';
  readonly modelId: string;
  readonly providerCode: 'cloudflare';
  readonly providerRequestId: string;
}

export interface ImageInspectionRequest {
  readonly body: Uint8Array;
  readonly expectedScene: string;
  readonly mimeType: 'image/jpeg' | 'image/png';
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface ImageInspectionResult {
  readonly articleRelevance: number;
  readonly companyNames: readonly string[];
  readonly decision: 'block' | 'pass';
  readonly deceptiveRealism: boolean;
  readonly detectedText: readonly string[];
  readonly issues: readonly string[];
  readonly logosOrWatermarks: readonly string[];
  readonly modelId: string;
  readonly phoneNumbers: readonly string[];
  readonly providerCode: 'cloudflare';
  readonly providerRequestId: string;
  readonly unsafe: boolean;
}

export interface ImageProvider {
  generate(input: ImageGenerationRequest): Promise<ImageGenerationResult>;
  inspect(input: ImageInspectionRequest): Promise<ImageInspectionResult>;
}

export interface ImageMetadata {
  readonly format: 'jpeg' | 'png' | 'webp';
  readonly height: number;
  readonly sizeBytes: number;
  readonly width: number;
}

export interface TemplateImageInput {
  readonly accent: 'blue' | 'gold' | 'teal';
  readonly label: string;
  readonly title: string;
}

export interface DouyinNoteCardInput {
  readonly background?: Uint8Array;
  readonly body: string;
  readonly heading: string;
  readonly index: number;
  readonly kind: 'cover' | 'body' | 'summary';
  readonly layout: 'checklist' | 'cover' | 'focus' | 'legacy' | 'photo' | 'summary';
  readonly title: string;
  readonly total: number;
}
