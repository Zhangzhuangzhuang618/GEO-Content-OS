import type { z } from 'zod';

import { parseOfficialSiteDeliveryConfig, type OfficialSiteDeliveryConfig } from './config.js';
import { OfficialSiteDeliveryError } from './errors.js';
import { exportOfficialSite, hashOfficialSitePayload, toOfficialSiteApiPayload } from './export.js';
import {
  OfficialSiteCapabilityResponseSchema,
  OfficialSiteDeliveryInputSchema,
  OfficialSiteMediaUploadInputSchema,
  OfficialSiteMediaUploadResponseSchema,
  OfficialSiteMetricsResponseSchema,
  OfficialSitePublishResponseSchema,
  OfficialSiteStatusResponseSchema,
} from './schema.js';
import { FetchOfficialSiteTransport } from './transport.js';
import {
  OFFICIAL_SITE_DELIVERY_VERSION,
  type OfficialSiteCapabilities,
  type OfficialSiteDeliveryInput,
  type OfficialSiteDeliveryResult,
  type OfficialSiteExportBundle,
  type OfficialSiteHttpResponse,
  type OfficialSiteHttpTransport,
  type OfficialSiteMediaUploadInput,
  type OfficialSiteMediaUploadResult,
  type OfficialSiteMetricsResult,
  type OfficialSitePublishResult,
  type OfficialSiteStatusResult,
} from './types.js';

type ApiConfig = Extract<OfficialSiteDeliveryConfig, { readonly mode: 'api' }>;

export class OfficialSiteDeliveryAdapter {
  private readonly configuration: OfficialSiteDeliveryConfig;
  private readonly transport: OfficialSiteHttpTransport;

  public constructor(configuration: unknown, transport?: OfficialSiteHttpTransport) {
    this.configuration = parseOfficialSiteDeliveryConfig(configuration);
    this.transport =
      transport ??
      new FetchOfficialSiteTransport(
        this.configuration.mode === 'api' ? this.configuration.timeout_ms : 10_000,
      );
  }

  public async capabilities(signal?: AbortSignal): Promise<OfficialSiteCapabilities> {
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
      const parsed = OfficialSiteCapabilityResponseSchema.safeParse(response.body);
      if (!parsed.success) return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
      return Object.freeze({
        export: true,
        get_status: parsed.data.get_status,
        media_upload: parsed.data.media_upload,
        metrics: parsed.data.metrics,
        publish: parsed.data.publish,
        version: OFFICIAL_SITE_DELIVERY_VERSION,
        warnings: Object.freeze([]),
      });
    } catch {
      return exportOnlyCapabilities('CAPABILITY_PROBE_FAILED');
    }
  }

  public async uploadMedia(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<OfficialSiteMediaUploadResult> {
    const configuration = this.requireApi('publish');
    const parsed = OfficialSiteMediaUploadInputSchema.parse(input) as OfficialSiteMediaUploadInput;
    let response: OfficialSiteHttpResponse;
    try {
      response = await this.requestApi(
        configuration,
        'POST',
        configuration.endpoints.media,
        signal,
        parsed.body,
        parsed.idempotency_key,
        parsed.idempotency_key,
        {
          'content-type': parsed.content_type,
          'x-content-sha256': parsed.content_hash,
          'x-content-version-id': parsed.content_version_id,
          'x-media-asset-id': parsed.asset_id,
          'x-media-role': parsed.role,
        },
      );
    } catch {
      throw new OfficialSiteDeliveryError(
        'MEDIA_UPLOAD_STATE_UNKNOWN',
        'Official site media upload ended without a conclusive response',
      );
    }
    if (response.status_code >= 500) {
      throw new OfficialSiteDeliveryError(
        'MEDIA_UPLOAD_STATE_UNKNOWN',
        'Official site media upload may have reached the remote system',
      );
    }
    if (!isSuccess(response.status_code)) {
      throw new OfficialSiteDeliveryError(
        'MEDIA_UPLOAD_REJECTED',
        'Official site rejected media upload',
      );
    }
    const result = OfficialSiteMediaUploadResponseSchema.safeParse(response.body);
    if (
      !result.success ||
      result.data.asset_id !== parsed.asset_id ||
      result.data.content_hash !== parsed.content_hash ||
      result.data.content_type !== parsed.content_type ||
      result.data.size_bytes !== parsed.body.byteLength
    ) {
      throw new OfficialSiteDeliveryError(
        'MEDIA_UPLOAD_STATE_UNKNOWN',
        'Official site accepted media but returned an invalid response',
      );
    }
    return result.data as OfficialSiteMediaUploadResult;
  }

  public async deliver(input: unknown, signal?: AbortSignal): Promise<OfficialSiteDeliveryResult> {
    const capabilities = await this.capabilities(signal);
    if (!capabilities.publish) {
      if (this.configuration.mode === 'export_only') {
        return { export: this.export(input), mode: 'export' };
      }
      throw new OfficialSiteDeliveryError(
        'CAPABILITY_UNAVAILABLE',
        'Configured official site API does not currently support publication',
      );
    }
    return { mode: 'api', publish: await this.publish(input, signal) };
  }

  public export(input: unknown): OfficialSiteExportBundle {
    return exportOfficialSite(input);
  }

  public async publish(input: unknown, signal?: AbortSignal): Promise<OfficialSitePublishResult> {
    const configuration = this.requireApi('publish');
    const parsed = requireDeliveryInput(input);
    requirePayloadHash(parsed);
    let response: OfficialSiteHttpResponse;
    try {
      response = await this.requestApi(
        configuration,
        'POST',
        configuration.endpoints.publish,
        signal,
        {
          content_version_id: parsed.content_version_id,
          payload: toOfficialSiteApiPayload(parsed.payload),
          payload_hash: parsed.payload_hash,
        },
        parsed.idempotency_key,
        parsed.idempotency_key,
      );
    } catch {
      throw new OfficialSiteDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Official site publish request ended without a conclusive response',
      );
    }
    if (response.status_code >= 500) {
      throw new OfficialSiteDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Official site publish request may have reached the remote system',
      );
    }
    if (!isSuccess(response.status_code)) {
      throw new OfficialSiteDeliveryError('PUBLISH_REJECTED', 'Official site rejected publication');
    }
    const parsedResponse = OfficialSitePublishResponseSchema.safeParse(response.body);
    if (!parsedResponse.success) {
      throw new OfficialSiteDeliveryError(
        'PUBLISH_STATE_UNKNOWN',
        'Official site accepted the request but returned an invalid publication response',
      );
    }
    return parsedResponse.data as OfficialSitePublishResult;
  }

  public async getStatus(
    externalId: string,
    signal?: AbortSignal,
  ): Promise<OfficialSiteStatusResult> {
    const configuration = this.requireApi('get_status');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.status}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(OfficialSiteStatusResponseSchema, response.body) as OfficialSiteStatusResult;
  }

  public async metrics(
    externalId: string,
    signal?: AbortSignal,
  ): Promise<OfficialSiteMetricsResult> {
    const configuration = this.requireApi('metrics');
    const response = await this.requestApi(
      configuration,
      'GET',
      `${configuration.endpoints.metrics}/${encodeURIComponent(requireExternalId(externalId))}`,
      signal,
    );
    requireSuccess(response);
    return parseRemote(
      OfficialSiteMetricsResponseSchema,
      response.body,
    ) as OfficialSiteMetricsResult;
  }

  private requireApi(capability: 'get_status' | 'metrics' | 'publish'): ApiConfig {
    if (this.configuration.mode !== 'api') {
      throw new OfficialSiteDeliveryError(
        'CAPABILITY_UNAVAILABLE',
        `Official site ${capability} capability is unavailable`,
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
    requestId?: string,
    extraHeaders?: Readonly<Record<string, string>>,
  ): Promise<OfficialSiteHttpResponse> {
    return this.transport.request({
      ...(body === undefined ? {} : { body }),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${configuration.bearer_token}`,
        ...(body === undefined || body instanceof Uint8Array
          ? {}
          : { 'content-type': 'application/json' }),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        ...(requestId ? { 'x-request-id': requestId } : {}),
        ...extraHeaders,
      },
      method,
      ...(signal ? { signal } : {}),
      url: new URL(path.replace(/^\//u, ''), normalizedBaseUrl(configuration.base_url)).toString(),
    });
  }
}

function exportOnlyCapabilities(
  warning: 'CAPABILITY_PROBE_FAILED' | 'EXPORT_ONLY',
): OfficialSiteCapabilities {
  return Object.freeze({
    export: true,
    get_status: false,
    media_upload: false,
    metrics: false,
    publish: false,
    version: OFFICIAL_SITE_DELIVERY_VERSION,
    warnings: Object.freeze([warning]),
  });
}

function requireDeliveryInput(input: unknown): OfficialSiteDeliveryInput {
  return OfficialSiteDeliveryInputSchema.parse(input) as OfficialSiteDeliveryInput;
}

function requirePayloadHash(input: OfficialSiteDeliveryInput): void {
  if (hashOfficialSitePayload(input.payload) !== input.payload_hash) {
    throw new OfficialSiteDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Official site payload hash does not match the frozen publish input',
    );
  }
}

function requireExternalId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 240) {
    throw new OfficialSiteDeliveryError('REMOTE_RESPONSE_INVALID', 'External id is invalid');
  }
  return normalized;
}

function requireSuccess(response: OfficialSiteHttpResponse): void {
  if (!isSuccess(response.status_code)) {
    throw new OfficialSiteDeliveryError('REMOTE_RESPONSE_INVALID', 'Official site request failed');
  }
}

function parseRemote<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new OfficialSiteDeliveryError(
      'REMOTE_RESPONSE_INVALID',
      'Official site returned an invalid response',
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
