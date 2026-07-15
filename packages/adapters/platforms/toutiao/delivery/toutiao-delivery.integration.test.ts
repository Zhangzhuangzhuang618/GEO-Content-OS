import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { renderToutiao } from '../render/src/render.js';
import { ToutiaoDeliveryAdapter } from './src/toutiao-delivery.adapter.js';
import { ToutiaoDeliveryConfigSchema } from './src/config.js';
import { ToutiaoDeliveryError } from './src/errors.js';
import { hashToutiaoPayload, stableStringify } from './src/export.js';
import type {
  ToutiaoDeliveryInput,
  ToutiaoHttpRequest,
  ToutiaoHttpResponse,
  ToutiaoHttpTransport,
} from './src/types.js';

describe('toutiao delivery integration', () => {
  it('creates the deterministic export golden when API publication is unavailable', async () => {
    const input = await deliveryInput();
    const golden = (await readJson('./fixtures/toutiao.export.golden.json')) as ExportGolden;
    const adapter = new ToutiaoDeliveryAdapter({ mode: 'export_only' });

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
        external_id: 'toutiao-108',
        status: 'published',
        url: 'https://publisher.example.com/articles/toutiao-108',
      }),
    ]);
    const adapter = apiAdapter(transport);
    const input = await deliveryInput();

    const result = await adapter.deliver(input);
    expect(result).toEqual({
      mode: 'api',
      publish: {
        external_id: 'toutiao-108',
        status: 'published',
        url: 'https://publisher.example.com/articles/toutiao-108',
      },
    });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://publisher.example.com/capabilities',
    });
    expect(transport.requests[1]).toMatchObject({
      body: {
        content_version_id: input.content_version_id,
        payload: input.payload,
        payload_hash: input.payload_hash,
      },
      headers: {
        authorization: 'Bearer test-secret',
        'idempotency-key': input.idempotency_key,
      },
      method: 'POST',
      url: 'https://publisher.example.com/publish',
    });
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('falls back to export only when capability probe says publish is unavailable', async () => {
    const transport = new FakeTransport([
      response(200, { get_status: false, metrics: false, publish: false }),
    ]);
    const result = await apiAdapter(transport).deliver(await deliveryInput());

    expect(result.mode).toBe('export');
    expect(transport.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('does not retry or export after a publish request enters an unknown state', async () => {
    const transport = new FakeTransport([
      response(200, { get_status: true, metrics: true, publish: true }),
      new Error('connection closed after request write'),
    ]);

    await expect(apiAdapter(transport).deliver(await deliveryInput())).rejects.toMatchObject({
      code: 'PUBLISH_STATE_UNKNOWN',
    });
    expect(transport.requests).toHaveLength(2);
  });

  it('treats an invalid successful publish response as an unknown state', async () => {
    const transport = new FakeTransport([response(201, { status: 'published' })]);

    await expect(apiAdapter(transport).publish(await deliveryInput())).rejects.toMatchObject({
      code: 'PUBLISH_STATE_UNKNOWN',
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('reads remote status and metric records without exposing credentials', async () => {
    const transport = new FakeTransport([
      response(200, {
        external_id: 'article/108',
        status: 'published',
        url: 'https://publisher.example.com/articles/108',
      }),
      response(200, {
        external_id: 'article/108',
        measured_at: '2026-07-15T08:00:00.000Z',
        metrics: { comments: 8, views: 280 },
      }),
    ]);
    const adapter = apiAdapter(transport);

    const status = await adapter.getStatus('article/108');
    const metrics = await adapter.metrics('article/108');
    expect(status.status).toBe('published');
    expect(metrics.metrics).toEqual({ comments: 8, views: 280 });
    expect(transport.requests.map((request) => request.url)).toEqual([
      'https://publisher.example.com/status/article%2F108',
      'https://publisher.example.com/metrics/article%2F108',
    ]);
    expect(JSON.stringify({ metrics, status })).not.toContain('test-secret');
  });

  it('rejects a payload that differs from its frozen hash before any API call', async () => {
    const transport = new FakeTransport([]);
    const adapter = apiAdapter(transport);
    const input = await deliveryInput();
    const invalid = { ...input, payload_hash: '0'.repeat(64) };

    expect(() => adapter.export(invalid)).toThrowError(ToutiaoDeliveryError);
    await expect(adapter.publish(invalid)).rejects.toMatchObject({ code: 'PAYLOAD_HASH_MISMATCH' });
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
      ToutiaoDeliveryConfigSchema.safeParse({
        base_url: 'https://user:password@publisher.example.com',
        bearer_token: 'secret',
        mode: 'api',
      }).success,
    ).toBe(false);
    expect(
      ToutiaoDeliveryConfigSchema.safeParse({
        base_url: 'https://publisher.example.com',
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
});

interface ExportGolden {
  readonly bundle_sha256: string;
  readonly file_paths: readonly string[];
  readonly schema_version: string;
}

class FakeTransport implements ToutiaoHttpTransport {
  public readonly requests: ToutiaoHttpRequest[] = [];

  public constructor(private readonly outcomes: (Error | ToutiaoHttpResponse)[]) {}

  public request(input: ToutiaoHttpRequest): Promise<ToutiaoHttpResponse> {
    this.requests.push(input);
    const outcome = this.outcomes.shift();
    if (!outcome) return Promise.reject(new Error('Unexpected request'));
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }
}

function apiAdapter(transport: ToutiaoHttpTransport) {
  return new ToutiaoDeliveryAdapter(
    {
      base_url: 'https://publisher.example.com/api',
      bearer_token: 'test-secret',
      mode: 'api',
    },
    transport,
  );
}

async function deliveryInput(): Promise<ToutiaoDeliveryInput> {
  const renderInput = await readJson('../render/fixtures/toutiao.valid.input.json');
  const rendered = renderToutiao(renderInput);
  if (!rendered.ok) throw new Error('Valid Toutiao render fixture failed');
  return {
    content_version_id: '30000000-0000-4000-8000-000000000108',
    idempotency_key: 'toutiao-delivery-108',
    payload: rendered.payload,
    payload_hash: hashToutiaoPayload(rendered.payload),
  };
}

function response(statusCode: number, body: unknown): ToutiaoHttpResponse {
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
