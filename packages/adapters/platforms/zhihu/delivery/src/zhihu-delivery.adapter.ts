import type { z } from 'zod';

import { parseZhihuDeliveryConfig, type ZhihuDeliveryConfig } from './config.js';
import { ZhihuDeliveryError } from './errors.js';
import { exportZhihu, hashZhihuPayload } from './export.js';
import {
  ZhihuCapabilityResponseSchema,
  ZhihuDeliveryInputSchema,
  ZhihuMetricsResponseSchema,
  ZhihuPublishResponseSchema,
  ZhihuStatusResponseSchema,
} from './schema.js';
import { FetchZhihuTransport } from './transport.js';
import {
  ZHIHU_DELIVERY_VERSION,
  type ZhihuCapabilities,
  type ZhihuDeliveryInput,
  type ZhihuDeliveryResult,
  type ZhihuExportBundle,
  type ZhihuHttpResponse,
  type ZhihuHttpTransport,
  type ZhihuMetricsResult,
  type ZhihuPublishResult,
  type ZhihuStatusResult,
} from './types.js';

type ApiConfig = Extract<ZhihuDeliveryConfig, { readonly mode: 'api' }>;

export class ZhihuDeliveryAdapter {
  private readonly configuration: ZhihuDeliveryConfig;
  private readonly transport: ZhihuHttpTransport;

  public constructor(configuration: unknown, transport?: ZhihuHttpTransport) {
    this.configuration = parseZhihuDeliveryConfig(configuration);
    this.transport =
      transport ??
      new FetchZhihuTransport(
        this.configuration.mode === 'api' ? this.configuration.timeout_ms : 10_000,
      );
  }

  public async capabilities(signal?: AbortSignal): Promise<ZhihuCapabilities> {
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
      const parsed = ZhihuCapabilityResponseSchema.safeParse(response.body);
      if (!parsed.success) return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
      return Object.freeze({
        export: true,
        get_status: parsed.data.get_status,
        metrics: parsed.data.metrics,
        publish: parsed.data.publish,
        version: ZHIHU_DELIVERY_VERSION,
        warnings: Object.freeze([]),
      });
    } catch {
      return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
    }
  }

  public async deliver(input: unknown, signal?: AbortSignal): Promise<ZhihuDeliveryResult> {
    const capabilities = await this.capabilities(signal);
    if (!capabilities.publish) return { export: this.export(input), mode: 'export' };
    return { mode: 'api', publish: await this.publish(input, signal) };
  }

  public export(input: unknown): ZhihuExportBundle {
    return exportZhihu(input);
  }

  public async publish(input: unknown, signal?: AbortSignal): Promise<ZhihuPublishResult> {
    const configuration = this.requireApi('publish');
    const parsed = requireDeliveryInput(input);
    requirePayloadHash(parsed);
    let response: ZhihuHttpResponse;
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
      throw new ZhihuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Zhihu publish request ended without a conclusive response',
      );
    }
    if (response.status_code >= 500) {
      throw new ZhihuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Zhihu publish request may have reached the remote system',
      );
    }
    if (!isSuccess(response.status_code)) {
      throw new ZhihuDeliveryError('PUBLISH_REJECTED', 'Zhihu rejected publication');
    }
    const parsedResponse = ZhihuPublishResponseSchema.safeParse(response.body);
    if (!parsedResponse.success) {
      throw new ZhihuDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Zhihu accepted the request but returned an invalid publication response',
      );
    }
    return parsedResponse.data as ZhihuPublishResult;
  }

  public async getStatus(externalId: string, signal?: AbortSignal): Promise<ZhihuStatusResult> {
    const configuration = this.requireApi('get_status');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.status}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(ZhihuStatusResponseSchema, response.body) as ZhihuStatusResult;
  }

  public async metrics(externalId: string, signal?: AbortSignal): Promise<ZhihuMetricsResult> {
    const configuration = this.requireApi('metrics');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.metrics}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(ZhihuMetricsResponseSchema, response.body) as ZhihuMetricsResult;
  }

  private requireApi(capability: 'get_status' | 'metrics' | 'publish'): ApiConfig {
    if (this.configuration.mode !== 'api') {
      throw new ZhihuDeliveryError(
        'CAPABILITY_UNAVAILABLE',
        `Zhihu ${capability} capability is unavailable`,
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
  ): Promise<ZhihuHttpResponse> {
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
): ZhihuCapabilities {
  return Object.freeze({
    export: true,
    get_status: false,
    metrics: false,
    publish: false,
    version: ZHIHU_DELIVERY_VERSION,
    warnings: Object.freeze([warning]),
  });
}

function requireDeliveryInput(input: unknown): ZhihuDeliveryInput {
  return ZhihuDeliveryInputSchema.parse(input) as ZhihuDeliveryInput;
}

function requirePayloadHash(input: ZhihuDeliveryInput): void {
  if (hashZhihuPayload(input.payload) !== input.payload_hash) {
    throw new ZhihuDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Zhihu payload hash does not match the frozen publish input',
    );
  }
}

function requireExternalId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 240) {
    throw new ZhihuDeliveryError('REMOTE_RESPONSE_INVALID', 'External id is invalid');
  }
  return normalized;
}

function requireSuccess(response: ZhihuHttpResponse): void {
  if (!isSuccess(response.status_code)) {
    throw new ZhihuDeliveryError('REMOTE_RESPONSE_INVALID', 'Zhihu request failed');
  }
}

function parseRemote<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ZhihuDeliveryError('REMOTE_RESPONSE_INVALID', 'Zhihu returned an invalid response');
  }
  return parsed.data as z.infer<T>;
}

function normalizedBaseUrl(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}
