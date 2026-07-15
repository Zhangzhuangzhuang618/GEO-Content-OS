import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { renderZhihu } from '../render/src/render.js';
import { ZhihuDeliveryAdapter } from './src/zhihu-delivery.adapter.js';
import { ZhihuDeliveryConfigSchema } from './src/config.js';
import { ZhihuDeliveryError } from './src/errors.js';
import { hashZhihuPayload, stableStringify } from './src/export.js';
import type {
  ZhihuDeliveryInput,
  ZhihuHttpRequest,
  ZhihuHttpResponse,
  ZhihuHttpTransport,
} from './src/types.js';

describe('zhihu delivery integration', () => {
  it('creates the deterministic export golden when API publication is unavailable', async () => {
    const input = await deliveryInput();
    const golden = (await readJson('./fixtures/zhihu.export.golden.json')) as ExportGolden;
    const adapter = new ZhihuDeliveryAdapter({ mode: 'export_only' });

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
        external_id: 'zhihu-110',
        status: 'published',
        url: 'https://publisher.example.com/answers/zhihu-110',
      }),
    ]);
    const adapter = apiAdapter(transport);
    const input = await deliveryInput();

    const result = await adapter.deliver(input);
    expect(result).toEqual({
      mode: 'api',
      publish: {
        external_id: 'zhihu-110',
        status: 'published',
        url: 'https://publisher.example.com/answers/zhihu-110',
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
        external_id: 'answer/110',
        status: 'published',
        url: 'https://publisher.example.com/answers/110',
      }),
      response(200, {
        external_id: 'answer/110',
        measured_at: '2026-07-15T08:00:00.000Z',
        metrics: { likes: 11, views: 310 },
      }),
    ]);
    const adapter = apiAdapter(transport);
    const status = await adapter.getStatus('answer/110');
    const metrics = await adapter.metrics('answer/110');
    expect(status.status).toBe('published');
    expect(metrics.metrics).toEqual({ likes: 11, views: 310 });
    expect(transport.requests.map((request) => request.url)).toEqual([
      'https://publisher.example.com/status/answer%2F110',
      'https://publisher.example.com/metrics/answer%2F110',
    ]);
    expect(JSON.stringify({ metrics, status })).not.toContain('test-secret');
  });

  it('rejects a payload that differs from its frozen hash before any API call', async () => {
    const transport = new FakeTransport([]);
    const adapter = apiAdapter(transport);
    const input = await deliveryInput();
    const invalid = { ...input, payload_hash: '0'.repeat(64) };
    expect(() => adapter.export(invalid)).toThrowError(ZhihuDeliveryError);
    await expect(adapter.publish(invalid)).rejects.toMatchObject({ code: 'PAYLOAD_HASH_MISMATCH' });
    expect(transport.requests).toHaveLength(0);
  });

  it('uses export-only capabilities when the probe response is invalid', async () => {
    const capabilities = await apiAdapter(
      new FakeTransport([response(200, { publish: true })]),
    ).capabilities();
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
      ZhihuDeliveryConfigSchema.safeParse({
        base_url: 'https://user:password@publisher.example.com',
        bearer_token: 'secret',
        mode: 'api',
      }).success,
    ).toBe(false);
    expect(
      ZhihuDeliveryConfigSchema.safeParse({
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

class FakeTransport implements ZhihuHttpTransport {
  public readonly requests: ZhihuHttpRequest[] = [];
  public constructor(private readonly outcomes: (Error | ZhihuHttpResponse)[]) {}

  public request(input: ZhihuHttpRequest): Promise<ZhihuHttpResponse> {
    this.requests.push(input);
    const outcome = this.outcomes.shift();
    if (!outcome) return Promise.reject(new Error('Unexpected request'));
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }
}

function apiAdapter(transport: ZhihuHttpTransport) {
  return new ZhihuDeliveryAdapter(
    {
      base_url: 'https://publisher.example.com/api',
      bearer_token: 'test-secret',
      mode: 'api',
    },
    transport,
  );
}

async function deliveryInput(): Promise<ZhihuDeliveryInput> {
  const renderInput = await readJson('../render/fixtures/zhihu.valid.input.json');
  const rendered = renderZhihu(renderInput);
  if (!rendered.ok) throw new Error('Valid Zhihu render fixture failed');
  return {
    content_version_id: '30000000-0000-4000-8000-000000000110',
    idempotency_key: 'zhihu-delivery-110',
    payload: rendered.payload,
    payload_hash: hashZhihuPayload(rendered.payload),
  };
}

function response(statusCode: number, body: unknown): ZhihuHttpResponse {
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
