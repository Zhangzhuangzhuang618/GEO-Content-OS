import type { z } from 'zod';

import { parseSohuDeliveryConfig, type SohuDeliveryConfig } from './config.js';
import { SohuDeliveryError } from './errors.js';
import { exportSohu, hashSohuPayload } from './export.js';
import {
  SohuCapabilityResponseSchema,
  SohuDeliveryInputSchema,
  SohuMetricsResponseSchema,
  SohuPublishResponseSchema,
  SohuStatusResponseSchema,
} from './schema.js';
import { FetchSohuTransport } from './transport.js';
import {
  SOHU_DELIVERY_VERSION,
  type SohuCapabilities,
  type SohuDeliveryInput,
  type SohuDeliveryResult,
  type SohuExportBundle,
  type SohuHttpResponse,
  type SohuHttpTransport,
  type SohuMetricsResult,
  type SohuPublishResult,
  type SohuStatusResult,
} from './types.js';

type ApiConfig = Extract<SohuDeliveryConfig, { readonly mode: 'api' }>;

export class SohuDeliveryAdapter {
  private readonly configuration: SohuDeliveryConfig;
  private readonly transport: SohuHttpTransport;

  public constructor(configuration: unknown, transport?: SohuHttpTransport) {
    this.configuration = parseSohuDeliveryConfig(configuration);
    this.transport =
      transport ??
      new FetchSohuTransport(
        this.configuration.mode === 'api' ? this.configuration.timeout_ms : 10_000,
      );
  }

  public async capabilities(signal?: AbortSignal): Promise<SohuCapabilities> {
    if (this.configuration.mode === 'export_only') return exportOnlyCapabilities('EXPORT_ONLY');
    try {
      const response = await this.requestApi(
        this.configuration,
        'GET',
        this.configuration.endpoints.capabilities,
        signal,
      );
      if (!isSuccess(response.status_code)) {
        return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
      }
      const parsed = SohuCapabilityResponseSchema.safeParse(response.body);
      if (!parsed.success) return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
      return Object.freeze({
        export: true,
        get_status: parsed.data.get_status,
        metrics: parsed.data.metrics,
        publish: parsed.data.publish,
        version: SOHU_DELIVERY_VERSION,
        warnings: Object.freeze([]),
      });
    } catch {
      return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
    }
  }

  public async deliver(input: unknown, signal?: AbortSignal): Promise<SohuDeliveryResult> {
    const capabilities = await this.capabilities(signal);
    if (!capabilities.publish) return { export: this.export(input), mode: 'export' };
    return { mode: 'api', publish: await this.publish(input, signal) };
  }

  public export(input: unknown): SohuExportBundle {
    return exportSohu(input);
  }

  public async publish(input: unknown, signal?: AbortSignal): Promise<SohuPublishResult> {
    const configuration = this.requireApi('publish');
    const parsed = requireDeliveryInput(input);
    requirePayloadHash(parsed);
    let response: SohuHttpResponse;
    try {
      response = await this.requestApi(
        configuration,
        'POST',
        configuration.endpoints.publish,
        signal,
        {
          content_version_id: parsed.content_version_id,
          payload: parsed.payload,
          payload_hash: parsed.payload_hash,
        },
        parsed.idempotency_key,
      );
    } catch {
      throw new SohuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Sohu publish request ended without a conclusive response',
      );
    }
    if (response.status_code >= 500) {
      throw new SohuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Sohu publish request may have reached the remote system',
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
        throw new SohuDeliveryError(
          'MANUAL_REQUIRED',
          'Sohu browser publication requires manual handling',
        );
      }
      throw new SohuDeliveryError('PUBLISH_REJECTED', 'Sohu rejected publication');
    }
    const parsedResponse = SohuPublishResponseSchema.safeParse(response.body);
    if (!parsedResponse.success) {
      throw new SohuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Sohu accepted the request but returned an invalid publication response',
      );
    }
    return parsedResponse.data as SohuPublishResult;
  }

  public async getStatus(externalId: string, signal?: AbortSignal): Promise<SohuStatusResult> {
    const configuration = this.requireApi('get_status');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.status}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(SohuStatusResponseSchema, response.body) as SohuStatusResult;
  }

  public async metrics(externalId: string, signal?: AbortSignal): Promise<SohuMetricsResult> {
    const configuration = this.requireApi('metrics');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.metrics}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(SohuMetricsResponseSchema, response.body) as SohuMetricsResult;
  }

  private requireApi(capability: 'get_status' | 'metrics' | 'publish'): ApiConfig {
    if (this.configuration.mode !== 'api') {
      throw new SohuDeliveryError(
        'CAPABILITY_UNAVAILABLE',
        `Sohu ${capability} capability is unavailable`,
      );
    }
    return this.configuration;
  }

  private requestApi(
    configuration: ApiConfig,
    method: 'GET' | 'POST',
    path: string,
    signal?: AbortSignal,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<SohuHttpResponse> {
    return this.transport.request({
      ...(body === undefined ? {} : { body }),
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
}

function exportOnlyCapabilities(
  warning: 'CAPABILITY_PROBE_FAILED' | 'EXPORT_ONLY',
): SohuCapabilities {
  return Object.freeze({
    export: true,
    get_status: false,
    metrics: false,
    publish: false,
    version: SOHU_DELIVERY_VERSION,
    warnings: Object.freeze([warning]),
  });
}

function requireDeliveryInput(input: unknown): SohuDeliveryInput {
  return SohuDeliveryInputSchema.parse(input) as SohuDeliveryInput;
}

function requirePayloadHash(input: SohuDeliveryInput): void {
  if (hashSohuPayload(input.payload) !== input.payload_hash) {
    throw new SohuDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Sohu payload hash does not match the frozen publish input',
    );
  }
}

function requireExternalId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 240) {
    throw new SohuDeliveryError('REMOTE_RESPONSE_INVALID', 'External id is invalid');
  }
  return normalized;
}

function requireSuccess(response: SohuHttpResponse): void {
  if (!isSuccess(response.status_code)) {
    throw new SohuDeliveryError('REMOTE_RESPONSE_INVALID', 'Sohu request failed');
  }
}

function parseRemote<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SohuDeliveryError('REMOTE_RESPONSE_INVALID', 'Sohu returned an invalid response');
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
