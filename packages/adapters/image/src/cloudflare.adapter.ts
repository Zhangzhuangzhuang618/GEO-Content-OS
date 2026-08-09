import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageInspectionRequest,
  ImageInspectionResult,
  ImageProvider,
  ImageProviderConfiguration,
} from './types.js';

type Fetch = typeof fetch;

export class CloudflareWorkersAiImageAdapter implements ImageProvider {
  public constructor(
    private readonly configuration: ImageProviderConfiguration,
    private readonly fetcher: Fetch = fetch,
  ) {}

  public async generate(input: ImageGenerationRequest): Promise<ImageGenerationResult> {
    validateGenerationInput(input);
    const response = await this.execute(
      this.configuration.generationModel,
      {
        prompt: input.prompt,
        seed: input.seed,
        steps: input.steps,
      },
      input.requestId,
      input.signal,
    );
    const result = object(response['result']);
    const encoded = string(result['image']);
    if (!encoded || encoded.length > 20_000_000) throw providerFailure('image response is invalid');
    const body = Uint8Array.from(Buffer.from(encoded, 'base64'));
    const mimeType = imageMimeType(body);
    return Object.freeze({
      body,
      mimeType,
      modelId: this.configuration.generationModel,
      providerCode: 'cloudflare',
      providerRequestId: providerRequestId(response, input.requestId),
    });
  }

  public async inspect(input: ImageInspectionRequest): Promise<ImageInspectionResult> {
    if (input.body.byteLength < 128 || input.body.byteLength > 10_000_000) {
      throw new TypeError('Image inspection body must contain 128-10000000 bytes');
    }
    if (!input.expectedScene.trim() || input.expectedScene.length > 2_000) {
      throw new TypeError('Image inspection expected scene is invalid');
    }
    const response = await this.execute(
      this.configuration.inspectionModel,
      {
        image: `data:${input.mimeType};base64,${Buffer.from(input.body).toString('base64')}`,
        max_tokens: 1_024,
        messages: [
          {
            content:
              'You are a strict machine gate for editorial illustrations. Return only one JSON object. Do not infer a pass when uncertain.',
            role: 'system',
          },
          {
            content: inspectionPrompt(input.expectedScene),
            role: 'user',
          },
        ],
        response_format: INSPECTION_RESPONSE_FORMAT,
        temperature: 0,
      },
      input.requestId,
      input.signal,
    );
    const result = object(response['result']);
    const responseValue = result['response'];
    const raw =
      typeof responseValue === 'string'
        ? responseValue
        : isObject(responseValue)
          ? responseValue
          : result;
    const parsed = typeof raw === 'string' ? parseJsonObject(raw) : object(raw);
    return parseInspection(parsed, this.configuration.inspectionModel, response, input.requestId);
  }

  private async execute(
    modelId: string,
    body: Readonly<Record<string, unknown>>,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(requestId))
      throw new TypeError('Image request id is invalid');
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Cloudflare image request timed out')),
      this.configuration.timeoutMs,
    );
    const abort = () => controller.abort(signal?.reason ?? new Error('Image request cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetcher(this.url(modelId), {
        body: JSON.stringify(body),
        headers: {
          authorization: `Bearer ${this.configuration.apiToken}`,
          'content-type': 'application/json',
          'x-client-request-id': requestId,
        },
        method: 'POST',
        signal: controller.signal,
      });
      if (!response.ok) throw providerFailure(`request failed with status ${response.status}`);
      const parsed = (await response.json()) as unknown;
      const envelope = object(parsed);
      if (envelope['success'] !== true || !isObject(envelope['result'])) {
        throw providerFailure('response envelope is invalid');
      }
      return envelope;
    } catch (error) {
      if (controller.signal.aborted) throw providerFailure('request timed out or was cancelled');
      if (error instanceof ImageProviderError) throw error;
      throw providerFailure('request failed');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  private url(modelId: string): string {
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.configuration.accountId)}/ai/run/${modelId}`;
  }
}

const INSPECTION_RESPONSE_FORMAT = Object.freeze({
  json_schema: {
    additionalProperties: false,
    properties: {
      article_relevance: { maximum: 100, minimum: 0, type: 'number' },
      company_names: { items: { type: 'string' }, type: 'array' },
      decision: { enum: ['pass', 'block'], type: 'string' },
      deceptive_realism: { type: 'boolean' },
      detected_text: { items: { type: 'string' }, type: 'array' },
      issues: { items: { type: 'string' }, type: 'array' },
      logos_or_watermarks: { items: { type: 'string' }, type: 'array' },
      phone_numbers: { items: { type: 'string' }, type: 'array' },
      unsafe: { type: 'boolean' },
    },
    required: [
      'decision',
      'article_relevance',
      'detected_text',
      'company_names',
      'logos_or_watermarks',
      'phone_numbers',
      'unsafe',
      'deceptive_realism',
      'issues',
    ],
    type: 'object',
  },
  type: 'json_schema',
});

export class ImageProviderError extends Error {
  public readonly code = 'IMAGE_PROVIDER_FAILED';
  public readonly retryable = true;
}

function validateGenerationInput(input: ImageGenerationRequest): void {
  if (!input.prompt.trim() || input.prompt.length > 2_048) {
    throw new TypeError('Image prompt must contain 1-2048 characters');
  }
  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 2_147_483_647) {
    throw new TypeError('Image seed must be a non-negative 32-bit integer');
  }
  if (!Number.isSafeInteger(input.steps) || input.steps < 1 || input.steps > 8) {
    throw new TypeError('Image steps must be an integer between 1 and 8');
  }
}

function inspectionPrompt(expectedScene: string): string {
  return `Inspect this generated image against the expected article scene below. It must be an editorial illustration, not documentary evidence. Block if it contains any readable text, company name, logo, watermark, phone number, unsafe content, or a realistic representation that could be mistaken for verified company staff, vehicles, premises, or a real customer case. Also block if the scene does not clearly match the article.\n\nExpected scene:\n${expectedScene}\n\nReturn exactly these fields: {"decision":"pass|block","article_relevance":0-100,"detected_text":[],"company_names":[],"logos_or_watermarks":[],"phone_numbers":[],"unsafe":false,"deceptive_realism":false,"issues":[]}.`;
}

function parseInspection(
  value: Readonly<Record<string, unknown>>,
  modelId: string,
  envelope: Readonly<Record<string, unknown>>,
  requestId: string,
): ImageInspectionResult {
  const decision = value['decision'];
  const articleRelevance = value['article_relevance'];
  if ((decision !== 'pass' && decision !== 'block') || !validScore(articleRelevance)) {
    throw providerFailure('inspection response is invalid');
  }
  return Object.freeze({
    articleRelevance,
    companyNames: strings(value['company_names']),
    decision,
    deceptiveRealism: boolean(value['deceptive_realism']),
    detectedText: strings(value['detected_text']),
    issues: strings(value['issues']),
    logosOrWatermarks: strings(value['logos_or_watermarks']),
    modelId,
    phoneNumbers: strings(value['phone_numbers']),
    providerCode: 'cloudflare',
    providerRequestId: providerRequestId(envelope, requestId),
    unsafe: boolean(value['unsafe']),
  });
}

function providerRequestId(value: Readonly<Record<string, unknown>>, fallback: string): string {
  return string(value['request_id']) || string(object(value['result'])['request_id']) || fallback;
}

function imageMimeType(body: Uint8Array): 'image/jpeg' | 'image/png' {
  if (body[0] === 0xff && body[1] === 0xd8 && body.at(-2) === 0xff && body.at(-1) === 0xd9) {
    return 'image/jpeg';
  }
  if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) {
    return 'image/png';
  }
  throw providerFailure('image MIME signature is invalid');
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> {
  try {
    return object(JSON.parse(value) as unknown);
  } catch {
    const labeled = parseLabeledInspection(value);
    if (labeled) return labeled;
    throw providerFailure('inspection JSON is invalid');
  }
}

function parseLabeledInspection(value: string): Readonly<Record<string, unknown>> | null {
  const decision = labeledField(value, 'Decision');
  const articleRelevance = labeledField(value, 'Article Relevance');
  const detectedText = labeledField(value, 'Detected Text');
  const companyNames = labeledField(value, 'Company Names');
  const logosOrWatermarks = labeledField(value, 'Logos or Watermarks');
  const phoneNumbers = labeledField(value, 'Phone Numbers');
  const unsafe = labeledField(value, 'Unsafe');
  const deceptiveRealism = labeledField(value, 'Deceptive Realism');
  const issues = labeledField(value, 'Issues');
  if (
    decision === null ||
    articleRelevance === null ||
    detectedText === null ||
    companyNames === null ||
    logosOrWatermarks === null ||
    phoneNumbers === null ||
    unsafe === null ||
    deceptiveRealism === null ||
    issues === null
  ) {
    return null;
  }
  return Object.freeze({
    article_relevance: Number(articleRelevance),
    company_names: jsonArray(companyNames),
    decision,
    deceptive_realism: strictBoolean(deceptiveRealism),
    detected_text: jsonArray(detectedText),
    issues: jsonArray(issues),
    logos_or_watermarks: jsonArray(logosOrWatermarks),
    phone_numbers: jsonArray(phoneNumbers),
    unsafe: strictBoolean(unsafe),
  });
}

function labeledField(value: string, label: string): string | null {
  const pattern = new RegExp(`^\\s*(?:\\*\\*)?${label}:(?:\\*\\*)?\\s*(.+?)\\s*$`, 'gimu');
  const matches = [...value.matchAll(pattern)];
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
}

function jsonArray(value: string): unknown {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function strictBoolean(value: string): boolean | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function strings(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length > 500)
  ) {
    throw providerFailure('inspection list is invalid');
  }
  return Object.freeze(value.map((item) => item.trim()).filter(Boolean));
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw providerFailure('inspection boolean is invalid');
  return value;
}

function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (!isObject(value)) throw providerFailure('provider response object is invalid');
  return value;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function providerFailure(message: string): ImageProviderError {
  return new ImageProviderError(`Cloudflare Workers AI ${message}`);
}
