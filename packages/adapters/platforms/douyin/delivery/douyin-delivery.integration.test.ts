import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { renderDouyin } from '../render/src/render.js';
import { DouyinDeliveryConfigSchema } from './src/config.js';
import { DouyinDeliveryError } from './src/errors.js';
import { hashDouyinPayload, stableStringify } from './src/export.js';
import type {
  DouyinDeliveryInput,
  DouyinHttpRequest,
  DouyinHttpResponse,
  DouyinHttpTransport,
} from './src/types.js';
import { DouyinDeliveryAdapter } from './src/douyin-delivery.adapter.js';

describe('douyin delivery integration', () => {
  it('defaults to a deterministic script export without API configuration', async () => {
    const input = await deliveryInput();
    const golden = (await readJson('./fixtures/douyin.export.golden.json')) as ExportGolden;
    const adapter = new DouyinDeliveryAdapter();
    const first = await adapter.deliver(input);
    const second = await adapter.deliver(input);
    expect(first).toEqual(second);
    expect(first.mode).toBe('export');
    if (first.mode !== 'export') return;
    expect(first.export.schema_version).toBe(golden.schema_version);
    expect(first.export.files.map((file) => file.path)).toEqual(golden.file_paths);
    expect(bundleHash(first.export)).toBe(golden.bundle_sha256);
    expect(first.export.files.every((file) => sha256(file.body) === file.sha256)).toBe(true);
    const subtitles = first.export.files.find((file) => file.path.endsWith('/subtitles.srt'));
    expect(subtitles?.body).toContain('00:00:00,000 --> 00:00:03,000');
  });

  it('uses a configured API only after capability confirmation', async () => {
    const transport = new FakeTransport([
      response(200, { get_status: true, metrics: true, publish: true }),
      response(201, {
        external_id: 'douyin-116',
        status: 'processing',
        url: null,
      }),
    ]);
    const input = await deliveryInput();
    const result = await apiAdapter(transport).deliver(input);
    expect(result).toEqual({
      mode: 'api',
      publish: { external_id: 'douyin-116', status: 'processing', url: null },
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
  });

  it('exports when capability probing denies publication', async () => {
    const transport = new FakeTransport([
      response(200, { get_status: false, metrics: false, publish: false }),
    ]);
    const result = await apiAdapter(transport).deliver(await deliveryInput());
    expect(result.mode).toBe('export');
    expect(transport.requests).toHaveLength(1);
  });

  it('does not retry or export after publication enters an unknown state', async () => {
    const transport = new FakeTransport([
      response(200, { get_status: true, metrics: true, publish: true }),
      new Error('connection closed after write'),
    ]);
    await expect(apiAdapter(transport).deliver(await deliveryInput())).rejects.toMatchObject({
      code: 'PUBLISH_STATE_UNKNOWN',
    });
    expect(transport.requests).toHaveLength(2);
  });

  it('treats malformed successful publication as unknown', async () => {
    const transport = new FakeTransport([response(201, { status: 'published' })]);
    await expect(apiAdapter(transport).publish(await deliveryInput())).rejects.toMatchObject({
      code: 'PUBLISH_STATE_UNKNOWN',
    });
  });

  it('reads status and metrics using encoded external ids', async () => {
    const transport = new FakeTransport([
      response(200, {
        external_id: 'video/116',
        status: 'published',
        url: 'https://publisher.example.com/videos/116',
      }),
      response(200, {
        external_id: 'video/116',
        measured_at: '2026-07-15T12:00:00.000Z',
        metrics: { likes: 90, plays: 1500 },
      }),
    ]);
    const adapter = apiAdapter(transport);
    expect((await adapter.getStatus('video/116')).status).toBe('published');
    expect((await adapter.metrics('video/116')).metrics).toEqual({ likes: 90, plays: 1500 });
    expect(transport.requests.map((request) => request.url)).toEqual([
      'https://publisher.example.com/status/video%2F116',
      'https://publisher.example.com/metrics/video%2F116',
    ]);
  });

  it('rejects changed payloads before any API call', async () => {
    const transport = new FakeTransport([]);
    const adapter = apiAdapter(transport);
    const invalid = { ...(await deliveryInput()), payload_hash: '0'.repeat(64) };
    expect(() => adapter.export(invalid)).toThrowError(DouyinDeliveryError);
    await expect(adapter.publish(invalid)).rejects.toMatchObject({ code: 'PAYLOAD_HASH_MISMATCH' });
    expect(transport.requests).toHaveLength(0);
  });

  it('falls back safely when capability payload is invalid', async () => {
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

  it('does not expose credentials in returned values', async () => {
    const transport = new FakeTransport([
      response(200, { get_status: true, metrics: true, publish: true }),
      response(201, { external_id: '116', status: 'published', url: null }),
    ]);
    const result = await apiAdapter(transport).deliver(await deliveryInput());
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('rejects credentials in base URLs and protocol-relative endpoints', () => {
    expect(
      DouyinDeliveryConfigSchema.safeParse({
        base_url: 'https://user:password@publisher.example.com',
        bearer_token: 'secret',
        mode: 'api',
      }).success,
    ).toBe(false);
    expect(
      DouyinDeliveryConfigSchema.safeParse({
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
  bundle_sha256: string;
  file_paths: string[];
  schema_version: string;
}
class FakeTransport implements DouyinHttpTransport {
  public readonly requests: DouyinHttpRequest[] = [];
  public constructor(private readonly outcomes: (DouyinHttpResponse | Error)[]) {}
  public request(input: DouyinHttpRequest): Promise<DouyinHttpResponse> {
    this.requests.push(input);
    const outcome = this.outcomes.shift();
    if (!outcome) return Promise.reject(new Error('Unexpected request'));
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }
}
function apiAdapter(transport: DouyinHttpTransport): DouyinDeliveryAdapter {
  return new DouyinDeliveryAdapter(
    {
      base_url: 'https://publisher.example.com/api',
      bearer_token: 'test-secret',
      mode: 'api',
    },
    transport,
  );
}
async function deliveryInput(): Promise<DouyinDeliveryInput> {
  const renderInput = await readJson('../render/fixtures/douyin.valid.input.json');
  const rendered = renderDouyin(renderInput);
  if (!rendered.ok) throw new Error('Valid Douyin render fixture failed');
  return {
    content_version_id: '30000000-0000-4000-8000-000000000116',
    idempotency_key: 'douyin-delivery-116',
    payload: rendered.payload,
    payload_hash: hashDouyinPayload(rendered.payload),
  };
}
function response(statusCode: number, body: unknown): DouyinHttpResponse {
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
