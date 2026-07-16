import type { z } from 'zod';

import { parseWechatMpDeliveryConfig, type WechatMpDeliveryConfig } from './config.js';
import { WechatMpDeliveryError } from './errors.js';
import { exportWechatMp, hashWechatMpPayload } from './export.js';
import {
  WechatMpCapabilityResponseSchema,
  WechatMpDeliveryInputSchema,
  WechatMpMetricsResponseSchema,
  WechatMpPublishResponseSchema,
  WechatMpStatusResponseSchema,
} from './schema.js';
import { FetchWechatMpTransport } from './transport.js';
import {
  WECHAT_MP_DELIVERY_VERSION,
  type WechatMpCapabilities,
  type WechatMpDeliveryInput,
  type WechatMpDeliveryResult,
  type WechatMpExportBundle,
  type WechatMpHttpResponse,
  type WechatMpHttpTransport,
  type WechatMpMetricsResult,
  type WechatMpPublishResult,
  type WechatMpStatusResult,
} from './types.js';

type ApiConfig = Extract<WechatMpDeliveryConfig, { readonly mode: 'api' }>;

export class WechatMpDeliveryAdapter {
  private readonly configuration: WechatMpDeliveryConfig;
  private readonly transport: WechatMpHttpTransport;

  public constructor(configuration?: unknown, transport?: WechatMpHttpTransport) {
    this.configuration = parseWechatMpDeliveryConfig(configuration);
    this.transport =
      transport ??
      new FetchWechatMpTransport(
        this.configuration.mode === 'api' ? this.configuration.timeout_ms : 10_000,
      );
  }

  public async capabilities(signal?: AbortSignal): Promise<WechatMpCapabilities> {
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
      const parsed = WechatMpCapabilityResponseSchema.safeParse(response.body);
      if (!parsed.success) return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
      return Object.freeze({
        export: true,
        get_status: parsed.data.get_status,
        metrics: parsed.data.metrics,
        publish: parsed.data.publish,
        version: WECHAT_MP_DELIVERY_VERSION,
        warnings: Object.freeze([]),
      });
    } catch {
      return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
    }
  }

  public async deliver(input: unknown, signal?: AbortSignal): Promise<WechatMpDeliveryResult> {
    const capabilities = await this.capabilities(signal);
    if (!capabilities.publish) return { export: this.export(input), mode: 'export' };
    return { mode: 'api', publish: await this.publish(input, signal) };
  }
  public export(input: unknown): WechatMpExportBundle {
    return exportWechatMp(input);
  }
  public async publish(input: unknown, signal?: AbortSignal): Promise<WechatMpPublishResult> {
    const configuration = this.requireApi('publish');
    const parsed = requireDeliveryInput(input);
    requirePayloadHash(parsed);
    let response: WechatMpHttpResponse;
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
      throw new WechatMpDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Wechat MP publish request ended without a conclusive response',
      );
    }
    if (response.status_code >= 500) {
      throw new WechatMpDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Wechat MP publish request may have reached the remote system',
      );
    }
    if (!isSuccess(response.status_code)) {
      throw new WechatMpDeliveryError('PUBLISH_REJECTED', 'Wechat MP rejected publication');
    }
    const parsedResponse = WechatMpPublishResponseSchema.safeParse(response.body);
    if (!parsedResponse.success) {
      throw new WechatMpDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Wechat MP accepted the request but returned an invalid publication response',
      );
    }
    return parsedResponse.data as WechatMpPublishResult;
  }

  public async getStatus(externalId: string, signal?: AbortSignal): Promise<WechatMpStatusResult> {
    const configuration = this.requireApi('get_status');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.status}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(WechatMpStatusResponseSchema, response.body) as WechatMpStatusResult;
  }
  public async metrics(externalId: string, signal?: AbortSignal): Promise<WechatMpMetricsResult> {
    const configuration = this.requireApi('metrics');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.metrics}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(WechatMpMetricsResponseSchema, response.body) as WechatMpMetricsResult;
  }

  private requireApi(capability: 'get_status' | 'metrics' | 'publish'): ApiConfig {
    if (this.configuration.mode !== 'api') {
      throw new WechatMpDeliveryError(
        'CAPABILITY_UNAVAILABLE',
        `Wechat MP ${capability} capability is unavailable`,
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
  ): Promise<WechatMpHttpResponse> {
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
): WechatMpCapabilities {
  return Object.freeze({
    export: true,
    get_status: false,
    metrics: false,
    publish: false,
    version: WECHAT_MP_DELIVERY_VERSION,
    warnings: Object.freeze([warning]),
  });
}
function requireDeliveryInput(input: unknown): WechatMpDeliveryInput {
  return WechatMpDeliveryInputSchema.parse(input) as WechatMpDeliveryInput;
}
function requirePayloadHash(input: WechatMpDeliveryInput): void {
  if (hashWechatMpPayload(input.payload) !== input.payload_hash) {
    throw new WechatMpDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Wechat MP payload hash does not match the frozen publish input',
    );
  }
}
function requireExternalId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    throw new WechatMpDeliveryError('REMOTE_RESPONSE_INVALID', 'External id is invalid');
  }
  return normalized;
}
function requireSuccess(response: WechatMpHttpResponse): void {
  if (!isSuccess(response.status_code)) {
    throw new WechatMpDeliveryError('REMOTE_RESPONSE_INVALID', 'Wechat MP request failed');
  }
}
function parseRemote<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new WechatMpDeliveryError(
      'REMOTE_RESPONSE_INVALID',
      'Wechat MP returned an invalid response',
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
