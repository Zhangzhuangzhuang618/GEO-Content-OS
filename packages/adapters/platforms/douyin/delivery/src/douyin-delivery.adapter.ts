import type { z } from 'zod';

import { parseDouyinDeliveryConfig, type DouyinDeliveryConfig } from './config.js';
import { DouyinDeliveryError } from './errors.js';
import { exportDouyin, hashDouyinPayload } from './export.js';
import {
  DouyinCapabilityResponseSchema,
  DouyinDeliveryInputSchema,
  DouyinMetricsResponseSchema,
  DouyinPublishResponseSchema,
  DouyinStatusResponseSchema,
} from './schema.js';
import { FetchDouyinTransport } from './transport.js';
import {
  DOUYIN_DELIVERY_VERSION,
  type DouyinCapabilities,
  type DouyinDeliveryInput,
  type DouyinDeliveryResult,
  type DouyinExportBundle,
  type DouyinHttpResponse,
  type DouyinHttpTransport,
  type DouyinMetricsResult,
  type DouyinPublishResult,
  type DouyinStatusResult,
} from './types.js';

type ApiConfig = Extract<DouyinDeliveryConfig, { readonly mode: 'api' }>;

export class DouyinDeliveryAdapter {
  private readonly configuration: DouyinDeliveryConfig;
  private readonly transport: DouyinHttpTransport;
  public constructor(configuration?: unknown, transport?: DouyinHttpTransport) {
    this.configuration = parseDouyinDeliveryConfig(configuration);
    this.transport =
      transport ??
      new FetchDouyinTransport(
        this.configuration.mode === 'api' ? this.configuration.timeout_ms : 10_000,
      );
  }

  public async capabilities(signal?: AbortSignal): Promise<DouyinCapabilities> {
    if (this.configuration.mode === 'export_only') return exportOnlyCapabilities('EXPORT_ONLY');
    try {
      const response = await this.requestApi(
        this.configuration,
        'GET',
        this.configuration.endpoints.capabilities,
        signal,
      );
      if (!isSuccess(response.status_code))
        return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
      const parsed = DouyinCapabilityResponseSchema.safeParse(response.body);
      if (!parsed.success) return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
      return Object.freeze({
        export: true,
        get_status: parsed.data.get_status,
        metrics: parsed.data.metrics,
        publish: parsed.data.publish,
        version: DOUYIN_DELIVERY_VERSION,
        warnings: Object.freeze([]),
      });
    } catch {
      return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
    }
  }
  public async deliver(input: unknown, signal?: AbortSignal): Promise<DouyinDeliveryResult> {
    const capabilities = await this.capabilities(signal);
    if (!capabilities.publish) return { export: this.export(input), mode: 'export' };
    return { mode: 'api', publish: await this.publish(input, signal) };
  }
  public export(input: unknown): DouyinExportBundle {
    return exportDouyin(input);
  }
  public async publish(input: unknown, signal?: AbortSignal): Promise<DouyinPublishResult> {
    const configuration = this.requireApi('publish');
    const parsed = requireDeliveryInput(input);
    requirePayloadHash(parsed);
    let response: DouyinHttpResponse;
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
      throw new DouyinDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Douyin publish request ended without a conclusive response',
      );
    }
    if (response.status_code >= 500) {
      throw new DouyinDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Douyin publish request may have reached the remote system',
      );
    }
    if (!isSuccess(response.status_code)) {
      throw new DouyinDeliveryError('PUBLISH_REJECTED', 'Douyin rejected publication');
    }
    const parsedResponse = DouyinPublishResponseSchema.safeParse(response.body);
    if (!parsedResponse.success) {
      throw new DouyinDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Douyin accepted the request but returned an invalid publication response',
      );
    }
    return parsedResponse.data as DouyinPublishResult;
  }
  public async getStatus(externalId: string, signal?: AbortSignal): Promise<DouyinStatusResult> {
    const configuration = this.requireApi('get_status');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.status}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(DouyinStatusResponseSchema, response.body) as DouyinStatusResult;
  }
  public async metrics(externalId: string, signal?: AbortSignal): Promise<DouyinMetricsResult> {
    const configuration = this.requireApi('metrics');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.metrics}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(DouyinMetricsResponseSchema, response.body) as DouyinMetricsResult;
  }
  private requireApi(capability: 'get_status' | 'metrics' | 'publish'): ApiConfig {
    if (this.configuration.mode !== 'api') {
      throw new DouyinDeliveryError(
        'CAPABILITY_UNAVAILABLE',
        `Douyin ${capability} capability is unavailable`,
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
  ): Promise<DouyinHttpResponse> {
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
): DouyinCapabilities {
  return Object.freeze({
    export: true,
    get_status: false,
    metrics: false,
    publish: false,
    version: DOUYIN_DELIVERY_VERSION,
    warnings: Object.freeze([warning]),
  });
}
function requireDeliveryInput(input: unknown): DouyinDeliveryInput {
  return DouyinDeliveryInputSchema.parse(input) as DouyinDeliveryInput;
}
function requirePayloadHash(input: DouyinDeliveryInput): void {
  if (hashDouyinPayload(input.payload) !== input.payload_hash) {
    throw new DouyinDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Douyin payload hash does not match the frozen publish input',
    );
  }
}
function requireExternalId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    throw new DouyinDeliveryError('REMOTE_RESPONSE_INVALID', 'External id is invalid');
  }
  return normalized;
}
function requireSuccess(response: DouyinHttpResponse): void {
  if (!isSuccess(response.status_code)) {
    throw new DouyinDeliveryError('REMOTE_RESPONSE_INVALID', 'Douyin request failed');
  }
}
function parseRemote<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DouyinDeliveryError('REMOTE_RESPONSE_INVALID', 'Douyin returned an invalid response');
  }
  return parsed.data as z.infer<T>;
}
function normalizedBaseUrl(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
function isSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}
