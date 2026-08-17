import type { z } from 'zod';

import { parseLiejuDeliveryConfig, type LiejuDeliveryConfig } from './config.js';
import { LiejuDeliveryError } from './errors.js';
import { exportLieju, hashLiejuPayload } from './export.js';
import {
  buildLiejuOfficialApiRequest,
  diagnoseLiejuOfficialApiResponse,
  parseLiejuOfficialApiResponse,
} from './official-api.js';
import {
  LiejuCapabilityResponseSchema,
  LiejuDeliveryInputSchema,
  LiejuMetricsResponseSchema,
  LiejuPublishResponseSchema,
  LiejuStatusResponseSchema,
} from './schema.js';
import { FetchLiejuTransport } from './transport.js';
import {
  LIEJU_DELIVERY_VERSION,
  type LiejuCapabilities,
  type LiejuDeliveryInput,
  type LiejuDeliveryResult,
  type LiejuExportBundle,
  type LiejuHttpResponse,
  type LiejuHttpTransport,
  type LiejuMetricsResult,
  type LiejuPublishResult,
  type LiejuStatusResult,
} from './types.js';

type ApiConfig = Extract<LiejuDeliveryConfig, { readonly mode: 'api' }>;
type BrowserConfig = Extract<ApiConfig, { readonly delivery_method: 'browser_gateway' }>;
type OfficialConfig = Extract<ApiConfig, { readonly delivery_method: 'official_api' }>;

export class LiejuDeliveryAdapter {
  private readonly configuration: LiejuDeliveryConfig;
  private readonly transport: LiejuHttpTransport;

  public constructor(configuration: unknown, transport?: LiejuHttpTransport) {
    this.configuration = parseLiejuDeliveryConfig(configuration);
    this.transport =
      transport ??
      new FetchLiejuTransport(
        this.configuration.mode === 'api' ? this.configuration.timeout_ms : 10_000,
      );
  }

  public async capabilities(signal?: AbortSignal): Promise<LiejuCapabilities> {
    if (this.configuration.mode === 'export_only') return exportOnlyCapabilities('EXPORT_ONLY');
    if (this.configuration.delivery_method === 'official_api') {
      void signal;
      return Object.freeze({
        export: true,
        get_status: false,
        metrics: false,
        publish: true,
        version: LIEJU_DELIVERY_VERSION,
        warnings: Object.freeze(['OFFICIAL_API_STATUS_UNAVAILABLE'] as const),
      });
    }
    try {
      const response = await this.requestBrowserApi(
        this.configuration,
        'GET',
        this.configuration.endpoints.capabilities,
        signal,
      );
      if (!isSuccess(response.status_code)) {
        return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
      }
      const parsed = LiejuCapabilityResponseSchema.safeParse(response.body);
      if (!parsed.success) return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
      return Object.freeze({
        export: true,
        get_status: parsed.data.get_status,
        metrics: parsed.data.metrics,
        publish: parsed.data.publish,
        version: LIEJU_DELIVERY_VERSION,
        warnings: Object.freeze([]),
      });
    } catch {
      return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
    }
  }

  public async deliver(input: unknown, signal?: AbortSignal): Promise<LiejuDeliveryResult> {
    const capabilities = await this.capabilities(signal);
    if (!capabilities.publish) return { export: this.export(input), mode: 'export' };
    return { mode: 'api', publish: await this.publish(input, signal) };
  }

  public export(input: unknown): LiejuExportBundle {
    return exportLieju(input);
  }

  public async publish(input: unknown, signal?: AbortSignal): Promise<LiejuPublishResult> {
    const configuration = this.requireApi('publish');
    const parsed = requireDeliveryInput(input);
    requirePayloadHash(parsed);
    if (configuration.delivery_method === 'official_api') {
      return this.publishOfficial(configuration, parsed, signal);
    }
    let response: LiejuHttpResponse;
    try {
      response = await this.requestBrowserApi(
        configuration,
        'POST',
        configuration.endpoints.publish,
        signal,
        {
          content_version_id: parsed.content_version_id,
          payload: parsed.payload,
          payload_hash: parsed.payload_hash,
          posting_profile: configuration.posting_profile,
        },
        parsed.idempotency_key,
      );
    } catch {
      throw new LiejuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Lieju publish request ended without a conclusive response',
      );
    }
    if (response.status_code >= 500) {
      throw new LiejuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Lieju publish request may have reached the remote system',
      );
    }
    if (!isSuccess(response.status_code)) {
      if (
        response.status_code === 401 ||
        response.status_code === 423 ||
        [
          'AUTH_REQUIRED',
          'CAPTCHA_REQUIRED',
          'MULTIPLE_MATCHES',
          'PAGE_SIGNATURE_CHANGED',
          'PUBLICATION_TERMINAL',
        ].includes(responseCode(response.body))
      ) {
        throw new LiejuDeliveryError(
          'MANUAL_REQUIRED',
          'Lieju browser publication requires manual handling',
        );
      }
      throw new LiejuDeliveryError('PUBLISH_REJECTED', 'Lieju rejected publication');
    }
    const parsedResponse = LiejuPublishResponseSchema.safeParse(response.body);
    if (!parsedResponse.success) {
      throw new LiejuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Lieju accepted the request but returned an invalid publication response',
      );
    }
    return parsedResponse.data as LiejuPublishResult;
  }

  public async getStatus(externalId: string, signal?: AbortSignal): Promise<LiejuStatusResult> {
    const configuration = this.requireApi('get_status');
    if (configuration.delivery_method === 'official_api') {
      void signal;
      return Object.freeze({
        external_id: requireExternalId(externalId),
        status: 'unknown',
        url: null,
      });
    }
    const response = await this.requestBrowserApi(
      configuration,
      'GET',
      `${configuration.endpoints.status}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(LiejuStatusResponseSchema, response.body) as LiejuStatusResult;
  }

  public async metrics(externalId: string, signal?: AbortSignal): Promise<LiejuMetricsResult> {
    const configuration = this.requireApi('metrics');
    if (configuration.delivery_method === 'official_api') {
      throw new LiejuDeliveryError(
        'CAPABILITY_UNAVAILABLE',
        'Lieju official API does not provide metrics',
      );
    }
    const response = await this.requestBrowserApi(
      configuration,
      'GET',
      `${configuration.endpoints.metrics}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(LiejuMetricsResponseSchema, response.body) as LiejuMetricsResult;
  }

  private requireApi(capability: 'get_status' | 'metrics' | 'publish'): ApiConfig {
    if (this.configuration.mode !== 'api') {
      throw new LiejuDeliveryError(
        'CAPABILITY_UNAVAILABLE',
        `Lieju ${capability} capability is unavailable`,
      );
    }
    return this.configuration;
  }

  private requestBrowserApi(
    configuration: BrowserConfig,
    method: 'GET' | 'POST',
    path: string,
    signal?: AbortSignal,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<LiejuHttpResponse> {
    const requestBody = body === undefined ? undefined : requireRecord(body);
    return this.transport.request({
      ...(requestBody === undefined ? {} : { body: requestBody }),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${configuration.bearer_token}`,
        ...(configuration.account_id ? { 'x-platform-account-id': configuration.account_id } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      method,
      ...(signal ? { signal } : {}),
      url: new URL(path, normalizedBaseUrl(configuration.base_url)).toString(),
    });
  }

  private async publishOfficial(
    configuration: OfficialConfig,
    input: LiejuDeliveryInput,
    signal?: AbortSignal,
  ): Promise<LiejuPublishResult> {
    const request = buildLiejuOfficialApiRequest(configuration, input);
    let response: LiejuHttpResponse;
    try {
      response = await this.transport.request({
        body: request.body,
        headers: {
          accept: 'application/json,text/plain,text/html;q=0.9',
          'content-type': request.contentType,
          referer: 'https://post.lieju.com/post_api.php',
        },
        method: 'POST',
        response_encoding: 'gbk',
        ...(signal ? { signal } : {}),
        url: configuration.endpoint,
      });
    } catch {
      throw new LiejuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Lieju official API request ended without a conclusive response',
      );
    }
    if (response.status_code >= 500) {
      throw new LiejuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Lieju official API may have accepted the publication request',
        diagnoseLiejuOfficialApiResponse(response.body, responseContext(response)),
      );
    }
    if (!isSuccess(response.status_code)) {
      throw new LiejuDeliveryError('PUBLISH_REJECTED', 'Lieju official API rejected publication');
    }
    const result = parseLiejuOfficialApiResponse(
      response.body,
      input.idempotency_key,
      responseContext(response),
    );
    if (!result.url) return result;
    return (await this.verifyPublicPublication(result.url, input.payload.title, signal))
      ? Object.freeze({ ...result, status: 'published' as const })
      : result;
  }

  private async verifyPublicPublication(
    url: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const response = await this.transport.request({
        headers: { accept: 'text/html' },
        method: 'GET',
        ...(signal ? { signal } : {}),
        url,
      });
      return isSuccess(response.status_code) && responseText(response.body).includes(title);
    } catch {
      return false;
    }
  }
}

function responseContext(response: LiejuHttpResponse) {
  return {
    ...(response.body_bytes === undefined ? {} : { bodyBytes: response.body_bytes }),
    ...(response.content_type === undefined ? {} : { contentType: response.content_type }),
    statusCode: response.status_code,
  };
}

function exportOnlyCapabilities(
  warning: 'CAPABILITY_PROBE_FAILED' | 'EXPORT_ONLY',
): LiejuCapabilities {
  return Object.freeze({
    export: true,
    get_status: false,
    metrics: false,
    publish: false,
    version: LIEJU_DELIVERY_VERSION,
    warnings: Object.freeze([warning]),
  });
}

function responseText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function requireDeliveryInput(input: unknown): LiejuDeliveryInput {
  return LiejuDeliveryInputSchema.parse(input) as LiejuDeliveryInput;
}

function requirePayloadHash(input: LiejuDeliveryInput): void {
  if (hashLiejuPayload(input.payload) !== input.payload_hash) {
    throw new LiejuDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Lieju payload hash does not match the frozen publish input',
    );
  }
}

function requireExternalId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 240) {
    throw new LiejuDeliveryError('REMOTE_RESPONSE_INVALID', 'External id is invalid');
  }
  return normalized;
}

function requireSuccess(response: LiejuHttpResponse): void {
  if (!isSuccess(response.status_code)) {
    throw new LiejuDeliveryError('REMOTE_RESPONSE_INVALID', 'Lieju request failed');
  }
}

function parseRemote<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new LiejuDeliveryError('REMOTE_RESPONSE_INVALID', 'Lieju returned an invalid response');
  }
  return parsed.data as z.infer<T>;
}

function normalizedBaseUrl(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function responseCode(value: unknown): string {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? String((value as Readonly<Record<string, unknown>>)['code'] ?? '')
    : '';
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LiejuDeliveryError('REMOTE_RESPONSE_INVALID', 'Lieju request body is invalid');
  }
  return value as Readonly<Record<string, unknown>>;
}
