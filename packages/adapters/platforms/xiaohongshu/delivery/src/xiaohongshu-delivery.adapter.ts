import type { z } from 'zod';

import { parseXiaohongshuDeliveryConfig, type XiaohongshuDeliveryConfig } from './config.js';
import { XiaohongshuDeliveryError } from './errors.js';
import { exportXiaohongshu, hashXiaohongshuPayload } from './export.js';
import {
  XiaohongshuCapabilityResponseSchema,
  XiaohongshuDeliveryInputSchema,
  XiaohongshuMetricsResponseSchema,
  XiaohongshuPublishResponseSchema,
  XiaohongshuStatusResponseSchema,
} from './schema.js';
import { FetchXiaohongshuTransport } from './transport.js';
import {
  XIAOHONGSHU_DELIVERY_VERSION,
  type XiaohongshuCapabilities,
  type XiaohongshuDeliveryInput,
  type XiaohongshuDeliveryResult,
  type XiaohongshuExportBundle,
  type XiaohongshuHttpResponse,
  type XiaohongshuHttpTransport,
  type XiaohongshuMetricsResult,
  type XiaohongshuPublishResult,
  type XiaohongshuStatusResult,
} from './types.js';

type ApiConfig = Extract<XiaohongshuDeliveryConfig, { readonly mode: 'api' }>;

export class XiaohongshuDeliveryAdapter {
  private readonly configuration: XiaohongshuDeliveryConfig;
  private readonly transport: XiaohongshuHttpTransport;

  public constructor(configuration?: unknown, transport?: XiaohongshuHttpTransport) {
    this.configuration = parseXiaohongshuDeliveryConfig(configuration);
    this.transport =
      transport ??
      new FetchXiaohongshuTransport(
        this.configuration.mode === 'api' ? this.configuration.timeout_ms : 10_000,
      );
  }

  public async capabilities(signal?: AbortSignal): Promise<XiaohongshuCapabilities> {
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
      const parsed = XiaohongshuCapabilityResponseSchema.safeParse(response.body);
      if (!parsed.success) return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
      return Object.freeze({
        export: true,
        get_status: parsed.data.get_status,
        metrics: parsed.data.metrics,
        publish: parsed.data.publish,
        version: XIAOHONGSHU_DELIVERY_VERSION,
        warnings: Object.freeze([]),
      });
    } catch {
      return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
    }
  }

  public async deliver(input: unknown, signal?: AbortSignal): Promise<XiaohongshuDeliveryResult> {
    const capabilities = await this.capabilities(signal);
    if (!capabilities.publish) return { export: this.export(input), mode: 'export' };
    return { mode: 'api', publish: await this.publish(input, signal) };
  }
  public export(input: unknown): XiaohongshuExportBundle {
    return exportXiaohongshu(input);
  }
  public async publish(input: unknown, signal?: AbortSignal): Promise<XiaohongshuPublishResult> {
    const configuration = this.requireApi('publish');
    const parsed = requireDeliveryInput(input);
    requirePayloadHash(parsed);
    let response: XiaohongshuHttpResponse;
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
      throw new XiaohongshuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Xiaohongshu publish request ended without a conclusive response',
      );
    }
    if (response.status_code >= 500) {
      throw new XiaohongshuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Xiaohongshu publish request may have reached the remote system',
      );
    }
    if (!isSuccess(response.status_code)) {
      throw new XiaohongshuDeliveryError('PUBLISH_REJECTED', 'Xiaohongshu rejected publication');
    }
    const parsedResponse = XiaohongshuPublishResponseSchema.safeParse(response.body);
    if (!parsedResponse.success) {
      throw new XiaohongshuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Xiaohongshu accepted the request but returned an invalid publication response',
      );
    }
    return parsedResponse.data as XiaohongshuPublishResult;
  }

  public async getStatus(
    externalId: string,
    signal?: AbortSignal,
  ): Promise<XiaohongshuStatusResult> {
    const configuration = this.requireApi('get_status');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.status}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(XiaohongshuStatusResponseSchema, response.body) as XiaohongshuStatusResult;
  }
  public async metrics(
    externalId: string,
    signal?: AbortSignal,
  ): Promise<XiaohongshuMetricsResult> {
    const configuration = this.requireApi('metrics');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.metrics}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(XiaohongshuMetricsResponseSchema, response.body) as XiaohongshuMetricsResult;
  }

  private requireApi(capability: 'get_status' | 'metrics' | 'publish'): ApiConfig {
    if (this.configuration.mode !== 'api') {
      throw new XiaohongshuDeliveryError(
        'CAPABILITY_UNAVAILABLE',
        `Xiaohongshu ${capability} capability is unavailable`,
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
  ): Promise<XiaohongshuHttpResponse> {
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
): XiaohongshuCapabilities {
  return Object.freeze({
    export: true,
    get_status: false,
    metrics: false,
    publish: false,
    version: XIAOHONGSHU_DELIVERY_VERSION,
    warnings: Object.freeze([warning]),
  });
}
function requireDeliveryInput(input: unknown): XiaohongshuDeliveryInput {
  return XiaohongshuDeliveryInputSchema.parse(input) as XiaohongshuDeliveryInput;
}
function requirePayloadHash(input: XiaohongshuDeliveryInput): void {
  if (hashXiaohongshuPayload(input.payload) !== input.payload_hash) {
    throw new XiaohongshuDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Xiaohongshu payload hash does not match the frozen publish input',
    );
  }
}
function requireExternalId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    throw new XiaohongshuDeliveryError('REMOTE_RESPONSE_INVALID', 'External id is invalid');
  }
  return normalized;
}
function requireSuccess(response: XiaohongshuHttpResponse): void {
  if (!isSuccess(response.status_code)) {
    throw new XiaohongshuDeliveryError('REMOTE_RESPONSE_INVALID', 'Xiaohongshu request failed');
  }
}
function parseRemote<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new XiaohongshuDeliveryError(
      'REMOTE_RESPONSE_INVALID',
      'Xiaohongshu returned an invalid response',
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
