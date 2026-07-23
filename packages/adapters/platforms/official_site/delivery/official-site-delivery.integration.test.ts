import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { renderOfficialSite } from '../render/src/render.js';
import { OfficialSiteDeliveryConfigSchema } from './src/config.js';
import { OfficialSiteDeliveryError } from './src/errors.js';
import {
  hashOfficialSitePayload,
  stableStringify,
  toOfficialSiteApiPayload,
} from './src/export.js';
import { OfficialSiteDeliveryAdapter } from './src/official-site-delivery.adapter.js';
import type {
  OfficialSiteDeliveryInput,
  OfficialSiteHttpRequest,
  OfficialSiteHttpResponse,
  OfficialSiteHttpTransport,
} from './src/types.js';

describe('official_site delivery integration', () => {
  it('creates the deterministic export golden when API publication is unavailable', async () => {
    const input = await deliveryInput();
    const golden = (await readJson('./fixtures/official-site.export.golden.json')) as ExportGolden;
    const adapter = new OfficialSiteDeliveryAdapter({ mode: 'export_only' });

    const first = await adapter.deliver(input);
    const second = await adapter.deliver(input);
    expect(first).toEqual(second);
    expect(first.mode).toBe('export');
    if (first.mode !== 'export') return;
    expect(first.export.schema_version).toBe(golden.schema_version);
    expect(first.export.files.map((file) => file.path)).toEqual(golden.file_paths);
    expect(bundleHash(first.export)).toBe(golden.bundle_sha256);
    expect(first.export.files.every((file) => sha256(file.body) === file.sha256)).toBe(true);
  });

  it('probes capabilities and calls the configured publish API with idempotency', async () => {
    const transport = new FakeTransport([
      response(200, { get_status: true, metrics: true, publish: true }),
      response(201, {
        external_id: 'article-103',
        published_at: '2026-07-15T08:00:00.000Z',
        status: 'published',
        url: 'https://cms.example.com/articles/article-103',
      }),
    ]);
    const adapter = apiAdapter(transport);
    const input = await deliveryInput();

    const result = await adapter.deliver(input);
    expect(result).toEqual({
      mode: 'api',
      publish: {
        external_id: 'article-103',
        published_at: '2026-07-15T08:00:00.000Z',
        status: 'published',
        url: 'https://cms.example.com/articles/article-103',
      },
    });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://cms.example.com/api/capabilities',
    });
    expect(transport.requests[1]).toMatchObject({
      body: {
        content_version_id: input.content_version_id,
        payload: toOfficialSiteApiPayload(input.payload),
        payload_hash: input.payload_hash,
      },
      headers: {
        authorization: 'Bearer test-secret',
        'idempotency-key': input.idempotency_key,
        'x-request-id': input.idempotency_key,
      },
      method: 'POST',
      url: 'https://cms.example.com/api/publish',
    });
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('fails closed when configured API publication is unavailable', async () => {
    const transport = new FakeTransport([
      response(200, { get_status: false, metrics: false, publish: false }),
    ]);
    const adapter = apiAdapter(transport);
    await expect(adapter.deliver(await deliveryInput())).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('does not retry or export after a publish request enters an unknown state', async () => {
    const transport = new FakeTransport([
      response(200, { get_status: true, metrics: true, publish: true }),
      new Error('connection closed after request write'),
    ]);
    const adapter = apiAdapter(transport);

    await expect(adapter.deliver(await deliveryInput())).rejects.toMatchObject({
      code: 'PUBLISH_STATE_UNKNOWN',
    });
    expect(transport.requests).toHaveLength(2);
  });

  it('treats an invalid successful publish response as an unknown state', async () => {
    const transport = new FakeTransport([response(201, { status: 'published' })]);
    const adapter = apiAdapter(transport);

    await expect(adapter.publish(await deliveryInput())).rejects.toMatchObject({
      code: 'PUBLISH_STATE_UNKNOWN',
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('accepts RFC 3339 timestamps with an explicit UTC offset', async () => {
    const transport = new FakeTransport([
      response(201, {
        external_id: 'article-104',
        published_at: '2026-07-15T16:00:00+08:00',
        status: 'published',
        url: 'https://cms.example.com/articles/article-104',
      }),
    ]);

    await expect(apiAdapter(transport).publish(await deliveryInput())).resolves.toMatchObject({
      external_id: 'article-104',
      published_at: '2026-07-15T16:00:00+08:00',
    });
  });

  it('reads remote status and metric records without exposing credentials', async () => {
    const transport = new FakeTransport([
      response(200, {
        external_id: 'article/103',
        published_at: '2026-07-15T08:00:00.000Z',
        status: 'published',
        url: 'https://cms.example.com/articles/103',
      }),
      response(200, {
        external_id: 'article/103',
        measured_at: '2026-07-15T08:00:00.000Z',
        metrics: { conversions: 4, views: 120 },
      }),
    ]);
    const adapter = apiAdapter(transport);

    const status = await adapter.getStatus('article/103');
    const metrics = await adapter.metrics('article/103');
    expect(status.status).toBe('published');
    expect(metrics.metrics).toEqual({ conversions: 4, views: 120 });
    expect(transport.requests.map((request) => request.url)).toEqual([
      'https://cms.example.com/api/status/article%2F103',
      'https://cms.example.com/api/metrics/article%2F103',
    ]);
    expect(JSON.stringify({ metrics, status })).not.toContain('test-secret');
  });

  it('rejects a payload that differs from its frozen hash before any API call', async () => {
    const transport = new FakeTransport([]);
    const adapter = apiAdapter(transport);
    const input = await deliveryInput();
    const invalid = { ...input, payload_hash: '0'.repeat(64) };

    expect(() => adapter.export(invalid)).toThrowError(OfficialSiteDeliveryError);
    await expect(adapter.publish(invalid)).rejects.toMatchObject({
      code: 'PAYLOAD_HASH_MISMATCH',
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('uses export-only capabilities when the probe response is invalid', async () => {
    const transport = new FakeTransport([response(200, { publish: true })]);
    const capabilities = await apiAdapter(transport).capabilities();

    expect(capabilities).toMatchObject({
      export: true,
      get_status: false,
      metrics: false,
      publish: false,
      warnings: ['CAPABILITY_PROBE_FAILED'],
    });
  });

  it('rejects credentials in base URLs and protocol-relative endpoint paths', () => {
    expect(
      OfficialSiteDeliveryConfigSchema.safeParse({
        base_url: 'https://user:password@cms.example.com',
        bearer_token: 'secret',
        mode: 'api',
      }).success,
    ).toBe(false);
    expect(
      OfficialSiteDeliveryConfigSchema.safeParse({
        base_url: 'https://cms.example.com',
        bearer_token: 'secret',
        endpoints: {
          capabilities: '//attacker.example.com',
          metrics: '/metrics',
          publish: '/publish',
          status: '/status',
        },
        mode: 'api',
      }).success,
    ).toBe(false);
  });

  it('requires HTTPS except for local loopback integration endpoints', () => {
    expect(
      OfficialSiteDeliveryConfigSchema.safeParse({
        base_url: 'http://cms.example.com/api/geo/v1',
        bearer_token: 'secret',
        mode: 'api',
      }).success,
    ).toBe(false);
    expect(
      OfficialSiteDeliveryConfigSchema.safeParse({
        base_url: 'http://127.0.0.1:18082/api/geo/v1',
        bearer_token: 'secret',
        mode: 'api',
      }).success,
    ).toBe(true);
  });
});

interface ExportGolden {
  readonly bundle_sha256: string;
  readonly file_paths: readonly string[];
  readonly schema_version: string;
}

class FakeTransport implements OfficialSiteHttpTransport {
  public readonly requests: OfficialSiteHttpRequest[] = [];

  public constructor(private readonly outcomes: (Error | OfficialSiteHttpResponse)[]) {}

  public request(input: OfficialSiteHttpRequest): Promise<OfficialSiteHttpResponse> {
    this.requests.push(input);
    const outcome = this.outcomes.shift();
    if (!outcome) return Promise.reject(new Error('Unexpected request'));
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }
}

function apiAdapter(transport: OfficialSiteHttpTransport) {
  return new OfficialSiteDeliveryAdapter(
    {
      base_url: 'https://cms.example.com/api',
      bearer_token: 'test-secret',
      mode: 'api',
    },
    transport,
  );
}

async function deliveryInput(): Promise<OfficialSiteDeliveryInput> {
  const renderInput = await readJson('../render/fixtures/official-site.valid.input.json');
  const rendered = renderOfficialSite(renderInput);
  if (!rendered.ok) throw new Error('Valid render fixture failed');
  return {
    content_version_id: '30000000-0000-4000-8000-000000000104',
    idempotency_key: 'official-site-delivery-104',
    payload: rendered.payload,
    payload_hash: hashOfficialSitePayload(rendered.payload),
  };
}

function response(statusCode: number, body: unknown): OfficialSiteHttpResponse {
  return { body, status_code: statusCode };
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8')) as unknown;
}

function bundleHash(value: unknown): string {
  return sha256(stableStringify(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
