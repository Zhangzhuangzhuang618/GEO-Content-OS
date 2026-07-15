import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { renderWechatMp } from '../render/src/render.js';
import { WechatMpDeliveryConfigSchema } from './src/config.js';
import { WechatMpDeliveryError } from './src/errors.js';
import { hashWechatMpPayload, stableStringify } from './src/export.js';
import type {
  WechatMpDeliveryInput,
  WechatMpHttpRequest,
  WechatMpHttpResponse,
  WechatMpHttpTransport,
} from './src/types.js';
import { WechatMpDeliveryAdapter } from './src/wechat-mp-delivery.adapter.js';

describe('wechat mp delivery integration', () => {
  it('defaults to deterministic export without API configuration', async () => {
    const input = await deliveryInput();
    const golden = (await readJson('./fixtures/wechat_mp.export.golden.json')) as ExportGolden;
    const adapter = new WechatMpDeliveryAdapter();
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

  it('uses an explicitly configured API only after capability confirmation', async () => {
    const transport = new FakeTransport([
      response(200, { get_status: true, metrics: true, publish: true }),
      response(201, {
        external_id: 'wechat-mp-114',
        status: 'published',
        url: 'https://publisher.example.com/articles/wechat-mp-114',
      }),
    ]);
    const input = await deliveryInput();
    const result = await apiAdapter(transport).deliver(input);
    expect(result).toEqual({
      mode: 'api',
      publish: {
        external_id: 'wechat-mp-114',
        status: 'published',
        url: 'https://publisher.example.com/articles/wechat-mp-114',
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
  });

  it('exports when the configured capability probe denies publication', async () => {
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
        external_id: 'article/114',
        status: 'published',
        url: 'https://publisher.example.com/articles/114',
      }),
      response(200, {
        external_id: 'article/114',
        measured_at: '2026-07-15T10:00:00.000Z',
        metrics: { reads: 420, shares: 18 },
      }),
    ]);
    const adapter = apiAdapter(transport);
    expect((await adapter.getStatus('article/114')).status).toBe('published');
    expect((await adapter.metrics('article/114')).metrics).toEqual({ reads: 420, shares: 18 });
    expect(transport.requests.map((request) => request.url)).toEqual([
      'https://publisher.example.com/status/article%2F114',
      'https://publisher.example.com/metrics/article%2F114',
    ]);
  });

  it('rejects changed payloads before any API call', async () => {
    const transport = new FakeTransport([]);
    const adapter = apiAdapter(transport);
    const invalid = { ...(await deliveryInput()), payload_hash: '0'.repeat(64) };
    expect(() => adapter.export(invalid)).toThrowError(WechatMpDeliveryError);
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
      response(201, { external_id: '114', status: 'published', url: null }),
    ]);
    const result = await apiAdapter(transport).deliver(await deliveryInput());
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('rejects credentials in base URLs and protocol-relative endpoints', () => {
    expect(
      WechatMpDeliveryConfigSchema.safeParse({
        base_url: 'https://user:password@publisher.example.com',
        bearer_token: 'secret',
        mode: 'api',
      }).success,
    ).toBe(false);
    expect(
      WechatMpDeliveryConfigSchema.safeParse({
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
class FakeTransport implements WechatMpHttpTransport {
  public readonly requests: WechatMpHttpRequest[] = [];
  public constructor(private readonly outcomes: (Error | WechatMpHttpResponse)[]) {}
  public request(input: WechatMpHttpRequest): Promise<WechatMpHttpResponse> {
    this.requests.push(input);
    const outcome = this.outcomes.shift();
    if (!outcome) return Promise.reject(new Error('Unexpected request'));
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }
}
function apiAdapter(transport: WechatMpHttpTransport): WechatMpDeliveryAdapter {
  return new WechatMpDeliveryAdapter(
    {
      base_url: 'https://publisher.example.com/api',
      bearer_token: 'test-secret',
      mode: 'api',
    },
    transport,
  );
}
async function deliveryInput(): Promise<WechatMpDeliveryInput> {
  const renderInput = await readJson('../render/fixtures/wechat_mp.valid.input.json');
  const rendered = renderWechatMp(renderInput);
  if (!rendered.ok) throw new Error('Valid Wechat MP render fixture failed');
  return {
    content_version_id: '30000000-0000-4000-8000-000000000114',
    idempotency_key: 'wechat-mp-delivery-114',
    payload: rendered.payload,
    payload_hash: hashWechatMpPayload(rendered.payload),
  };
}
function response(statusCode: number, body: unknown): WechatMpHttpResponse {
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
