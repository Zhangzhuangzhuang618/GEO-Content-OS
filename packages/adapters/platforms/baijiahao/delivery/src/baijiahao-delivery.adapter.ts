import type { z } from 'zod';

import { parseBaijiahaoDeliveryConfig, type BaijiahaoDeliveryConfig } from './config.js';
import { BaijiahaoDeliveryError } from './errors.js';
import { exportBaijiahao, hashBaijiahaoPayload } from './export.js';
import {
  BaijiahaoCapabilityResponseSchema,
  BaijiahaoDeliveryInputSchema,
  BaijiahaoMetricsResponseSchema,
  BaijiahaoPublishResponseSchema,
  BaijiahaoStatusResponseSchema,
} from './schema.js';
import { FetchBaijiahaoTransport } from './transport.js';
import {
  BAIJIAHAO_DELIVERY_VERSION,
  type BaijiahaoCapabilities,
  type BaijiahaoDeliveryInput,
  type BaijiahaoDeliveryResult,
  type BaijiahaoExportBundle,
  type BaijiahaoHttpResponse,
  type BaijiahaoHttpTransport,
  type BaijiahaoMetricsResult,
  type BaijiahaoPublishResult,
  type BaijiahaoStatusResult,
} from './types.js';

type ApiConfig = Extract<BaijiahaoDeliveryConfig, { readonly mode: 'api' }>;

export class BaijiahaoDeliveryAdapter {
  private readonly configuration: BaijiahaoDeliveryConfig;
  private readonly transport: BaijiahaoHttpTransport;

  public constructor(configuration: unknown, transport?: BaijiahaoHttpTransport) {
    this.configuration = parseBaijiahaoDeliveryConfig(configuration);
    this.transport =
      transport ??
      new FetchBaijiahaoTransport(
        this.configuration.mode === 'api' ? this.configuration.timeout_ms : 10_000,
      );
  }

  public async capabilities(signal?: AbortSignal): Promise<BaijiahaoCapabilities> {
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
      const parsed = BaijiahaoCapabilityResponseSchema.safeParse(response.body);
      if (!parsed.success) return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
      return Object.freeze({
        export: true,
        get_status: parsed.data.get_status,
        metrics: parsed.data.metrics,
        publish: parsed.data.publish,
        version: BAIJIAHAO_DELIVERY_VERSION,
        warnings: Object.freeze([]),
      });
    } catch {
      return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
    }
  }

  public async deliver(input: unknown, signal?: AbortSignal): Promise<BaijiahaoDeliveryResult> {
    const capabilities = await this.capabilities(signal);
    if (!capabilities.publish) return { export: this.export(input), mode: 'export' };
    return { mode: 'api', publish: await this.publish(input, signal) };
  }

  public export(input: unknown): BaijiahaoExportBundle {
    return exportBaijiahao(input);
  }

  public async publish(input: unknown, signal?: AbortSignal): Promise<BaijiahaoPublishResult> {
    const configuration = this.requireApi('publish');
    const parsed = requireDeliveryInput(input);
    requirePayloadHash(parsed);
    let response: BaijiahaoHttpResponse;
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
      throw new BaijiahaoDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Baijiahao publish request ended without a conclusive response',
      );
    }
    if (response.status_code >= 500) {
      throw new BaijiahaoDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Baijiahao publish request may have reached the remote system',
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
        throw new BaijiahaoDeliveryError(
          'MANUAL_REQUIRED',
          'Baijiahao browser publication requires manual handling',
        );
      }
      throw new BaijiahaoDeliveryError('PUBLISH_REJECTED', 'Baijiahao rejected publication');
    }
    const parsedResponse = BaijiahaoPublishResponseSchema.safeParse(response.body);
    if (!parsedResponse.success) {
      throw new BaijiahaoDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Baijiahao accepted the request but returned an invalid publication response',
      );
    }
    return parsedResponse.data as BaijiahaoPublishResult;
  }

  public async getStatus(externalId: string, signal?: AbortSignal): Promise<BaijiahaoStatusResult> {
    const configuration = this.requireApi('get_status');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.status}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(BaijiahaoStatusResponseSchema, response.body) as BaijiahaoStatusResult;
  }

  public async metrics(externalId: string, signal?: AbortSignal): Promise<BaijiahaoMetricsResult> {
    const configuration = this.requireApi('metrics');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.metrics}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(BaijiahaoMetricsResponseSchema, response.body) as BaijiahaoMetricsResult;
  }

  private requireApi(capability: 'get_status' | 'metrics' | 'publish'): ApiConfig {
    if (this.configuration.mode !== 'api') {
      throw new BaijiahaoDeliveryError(
        'CAPABILITY_UNAVAILABLE',
        `Baijiahao ${capability} capability is unavailable`,
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
  ): Promise<BaijiahaoHttpResponse> {
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
): BaijiahaoCapabilities {
  return Object.freeze({
    export: true,
    get_status: false,
    metrics: false,
    publish: false,
    version: BAIJIAHAO_DELIVERY_VERSION,
    warnings: Object.freeze([warning]),
  });
}

function requireDeliveryInput(input: unknown): BaijiahaoDeliveryInput {
  return BaijiahaoDeliveryInputSchema.parse(input) as BaijiahaoDeliveryInput;
}

function requirePayloadHash(input: BaijiahaoDeliveryInput): void {
  if (hashBaijiahaoPayload(input.payload) !== input.payload_hash) {
    throw new BaijiahaoDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Baijiahao payload hash does not match the frozen publish input',
    );
  }
}

function requireExternalId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 240) {
    throw new BaijiahaoDeliveryError('REMOTE_RESPONSE_INVALID', 'External id is invalid');
  }
  return normalized;
}

function requireSuccess(response: BaijiahaoHttpResponse): void {
  if (!isSuccess(response.status_code)) {
    throw new BaijiahaoDeliveryError('REMOTE_RESPONSE_INVALID', 'Baijiahao request failed');
  }
}

function parseRemote<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BaijiahaoDeliveryError(
      'REMOTE_RESPONSE_INVALID',
      'Baijiahao returned an invalid response',
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

function responseCode(value: unknown): string {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? String((value as Readonly<Record<string, unknown>>)['code'] ?? '')
    : '';
}
