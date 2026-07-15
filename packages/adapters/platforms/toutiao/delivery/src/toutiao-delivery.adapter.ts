import type { z } from 'zod';

import { parseToutiaoDeliveryConfig, type ToutiaoDeliveryConfig } from './config.js';
import { ToutiaoDeliveryError } from './errors.js';
import { exportToutiao, hashToutiaoPayload } from './export.js';
import {
  ToutiaoCapabilityResponseSchema,
  ToutiaoDeliveryInputSchema,
  ToutiaoMetricsResponseSchema,
  ToutiaoPublishResponseSchema,
  ToutiaoStatusResponseSchema,
} from './schema.js';
import { FetchToutiaoTransport } from './transport.js';
import {
  TOUTIAO_DELIVERY_VERSION,
  type ToutiaoCapabilities,
  type ToutiaoDeliveryInput,
  type ToutiaoDeliveryResult,
  type ToutiaoExportBundle,
  type ToutiaoHttpResponse,
  type ToutiaoHttpTransport,
  type ToutiaoMetricsResult,
  type ToutiaoPublishResult,
  type ToutiaoStatusResult,
} from './types.js';

type ApiConfig = Extract<ToutiaoDeliveryConfig, { readonly mode: 'api' }>;

export class ToutiaoDeliveryAdapter {
  private readonly configuration: ToutiaoDeliveryConfig;
  private readonly transport: ToutiaoHttpTransport;

  public constructor(configuration: unknown, transport?: ToutiaoHttpTransport) {
    this.configuration = parseToutiaoDeliveryConfig(configuration);
    this.transport =
      transport ??
      new FetchToutiaoTransport(
        this.configuration.mode === 'api' ? this.configuration.timeout_ms : 10_000,
      );
  }

  public async capabilities(signal?: AbortSignal): Promise<ToutiaoCapabilities> {
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
      const parsed = ToutiaoCapabilityResponseSchema.safeParse(response.body);
      if (!parsed.success) return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
      return Object.freeze({
        export: true,
        get_status: parsed.data.get_status,
        metrics: parsed.data.metrics,
        publish: parsed.data.publish,
        version: TOUTIAO_DELIVERY_VERSION,
        warnings: Object.freeze([]),
      });
    } catch {
      return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
    }
  }

  public async deliver(input: unknown, signal?: AbortSignal): Promise<ToutiaoDeliveryResult> {
    const capabilities = await this.capabilities(signal);
    if (!capabilities.publish) return { export: this.export(input), mode: 'export' };
    return { mode: 'api', publish: await this.publish(input, signal) };
  }

  public export(input: unknown): ToutiaoExportBundle {
    return exportToutiao(input);
  }

  public async publish(input: unknown, signal?: AbortSignal): Promise<ToutiaoPublishResult> {
    const configuration = this.requireApi('publish');
    const parsed = requireDeliveryInput(input);
    requirePayloadHash(parsed);
    let response: ToutiaoHttpResponse;
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
      throw new ToutiaoDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Toutiao publish request ended without a conclusive response',
      );
    }
    if (response.status_code >= 500) {
      throw new ToutiaoDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Toutiao publish request may have reached the remote system',
      );
    }
    if (!isSuccess(response.status_code)) {
      throw new ToutiaoDeliveryError('PUBLISH_REJECTED', 'Toutiao rejected publication');
    }
    const parsedResponse = ToutiaoPublishResponseSchema.safeParse(response.body);
    if (!parsedResponse.success) {
      throw new ToutiaoDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Toutiao accepted the request but returned an invalid publication response',
      );
    }
    return parsedResponse.data as ToutiaoPublishResult;
  }

  public async getStatus(externalId: string, signal?: AbortSignal): Promise<ToutiaoStatusResult> {
    const configuration = this.requireApi('get_status');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.status}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(ToutiaoStatusResponseSchema, response.body) as ToutiaoStatusResult;
  }

  public async metrics(externalId: string, signal?: AbortSignal): Promise<ToutiaoMetricsResult> {
    const configuration = this.requireApi('metrics');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.metrics}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(ToutiaoMetricsResponseSchema, response.body) as ToutiaoMetricsResult;
  }

  private requireApi(capability: 'get_status' | 'metrics' | 'publish'): ApiConfig {
    if (this.configuration.mode !== 'api') {
      throw new ToutiaoDeliveryError(
        'CAPABILITY_UNAVAILABLE',
        `Toutiao ${capability} capability is unavailable`,
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
  ): Promise<ToutiaoHttpResponse> {
    return this.transport.request({
      ...(body === undefined ? {} : { body }),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${configuration.bearer_token}`,
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
): ToutiaoCapabilities {
  return Object.freeze({
    export: true,
    get_status: false,
    metrics: false,
    publish: false,
    version: TOUTIAO_DELIVERY_VERSION,
    warnings: Object.freeze([warning]),
  });
}

function requireDeliveryInput(input: unknown): ToutiaoDeliveryInput {
  return ToutiaoDeliveryInputSchema.parse(input) as ToutiaoDeliveryInput;
}

function requirePayloadHash(input: ToutiaoDeliveryInput): void {
  if (hashToutiaoPayload(input.payload) !== input.payload_hash) {
    throw new ToutiaoDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Toutiao payload hash does not match the frozen publish input',
    );
  }
}

function requireExternalId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 240) {
    throw new ToutiaoDeliveryError('REMOTE_RESPONSE_INVALID', 'External id is invalid');
  }
  return normalized;
}

function requireSuccess(response: ToutiaoHttpResponse): void {
  if (!isSuccess(response.status_code)) {
    throw new ToutiaoDeliveryError('REMOTE_RESPONSE_INVALID', 'Toutiao request failed');
  }
}

function parseRemote<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ToutiaoDeliveryError(
      'REMOTE_RESPONSE_INVALID',
      'Toutiao returned an invalid response',
    );
  }
  return parsed.data as z.infer<T>;
}

function normalizedBaseUrl(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}
