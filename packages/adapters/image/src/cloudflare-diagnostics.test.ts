import { afterEach, describe, expect, it, vi } from 'vitest';

import { CloudflareWorkersAiImageAdapter } from './cloudflare.adapter.js';

const configuration = {
  accountId: 'private-account',
  apiToken: 'private-api-token',
  generationModel: '@cf/black-forest-labs/flux-1-schnell',
  inspectionModel: '@cf/meta/llama-3.2-11b-vision-instruct',
  timeoutMs: 5_000,
};
const input = {
  prompt: 'Private customer scene',
  requestId: 'task-1:generate:1',
  seed: 7,
  steps: 4,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Cloudflare failure diagnostics', () => {
  it.each([3036, 3040, 5006])(
    'logs provider code %s and trace headers without changing the error',
    async (code) => {
      const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetcher = vi.fn(async () =>
        Response.json(
          {
            success: false,
            errors: [{ code, message: 'Provider rejected request' }],
            request_id: 'provider-123',
          },
          { status: 429, headers: { 'cf-ray': 'ray-123-SJC', 'retry-after': '60' } },
        ),
      );
      const adapter = new CloudflareWorkersAiImageAdapter(configuration, fetcher);
      await expect(adapter.generate(input)).rejects.toMatchObject({
        code: 'IMAGE_PROVIDER_FAILED',
        retryable: true,
        message: 'Cloudflare Workers AI request failed with status 429',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        event: 'cloudflare_image_provider_failure',
        operation: 'generate',
        model_id: configuration.generationModel,
        request_id: input.requestId,
        http_status: 429,
        cf_ray: 'ray-123-SJC',
        provider_request_id: 'provider-123',
        retry_after: '60',
        errors: [{ code, message: 'Provider rejected request' }],
        error_body_available: true,
      });
    },
  );

  it('redacts credentials, echoed inputs and personal data, and ignores other response fields', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = async () =>
      Response.json(
        {
          errors: [
            {
              code: 3036,
              message: `${configuration.apiToken} ${configuration.accountId} ${input.prompt} Bearer other-secret token=another-secret a@b.com 13800138000 https://example.com/secret data:image/png;base64,secret-image`,
            },
          ],
          result: { image: 'private-image' },
          prompt: 'unrelated-private-prompt',
          authorization: 'private-auth',
        },
        { status: 429 },
      );
    const adapter = new CloudflareWorkersAiImageAdapter(configuration, fetcher);
    await expect(adapter.generate(input)).rejects.toThrow('status 429');
    const output = String(log.mock.calls[0]?.[0]);
    for (const secret of [
      configuration.apiToken,
      configuration.accountId,
      input.prompt,
      'other-secret',
      'another-secret',
      'a@b.com',
      '13800138000',
      'example.com',
      'secret-image',
      'private-image',
      'unrelated-private-prompt',
      'private-auth',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('3036');
  });

  it('distinguishes inspection errors and redacts echoed vision input', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json(
        { errors: [{ code: 3040, message: `${body.image} ${body.messages[1].content}` }] },
        { status: 429 },
      );
    };
    const adapter = new CloudflareWorkersAiImageAdapter(configuration, fetcher);
    await expect(
      adapter.inspect({
        body: new Uint8Array(128),
        mimeType: 'image/png',
        expectedScene: 'Private scene description',
        requestId: 'task-1:inspect:1',
      }),
    ).rejects.toThrow('status 429');
    const output = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      operation: 'inspect',
      model_id: configuration.inspectionModel,
      request_id: 'task-1:inspect:1',
    });
    expect(output).not.toContain('Private scene description');
    expect(output).not.toContain('base64');
  });

  it.each(['<html>private upstream error</html>', '{invalid', 'x'.repeat(17_000)])(
    'does not log non-JSON or oversized bodies',
    async (body) => {
      const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const adapter = new CloudflareWorkersAiImageAdapter(
        configuration,
        async () => new Response(body, { status: 503 }),
      );
      await expect(adapter.generate(input)).rejects.toThrow('status 503');
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        http_status: 503,
        error_body_available: false,
        errors: [],
      });
      expect(String(log.mock.calls[0]?.[0])).not.toContain(body);
    },
  );

  it('bounds diagnostic waiting for an unfinished error response', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cancel = vi.fn();
    const adapter = new CloudflareWorkersAiImageAdapter(
      configuration,
      async () => new Response(new ReadableStream({ cancel }), { status: 429 }),
    );
    const result = expect(adapter.generate(input)).rejects.toThrow('status 429');
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('preserves HTTP errors if reading the diagnostic body fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = new CloudflareWorkersAiImageAdapter(
      configuration,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('broken body'));
            },
          }),
          { status: 429 },
        ),
    );
    await expect(adapter.generate(input)).rejects.toThrow('status 429');
  });

  it('preserves HTTP errors if the logger throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    const adapter = new CloudflareWorkersAiImageAdapter(configuration, async () =>
      Response.json({ errors: [{ code: 3040 }] }, { status: 429 }),
    );
    await expect(adapter.generate(input)).rejects.toThrow('status 429');
  });

  it('bounds error count and message length', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = new CloudflareWorkersAiImageAdapter(configuration, async () =>
      Response.json(
        { errors: Array.from({ length: 7 }, () => ({ code: 3040, message: 'x'.repeat(1_000) })) },
        { status: 429 },
      ),
    );
    await expect(adapter.generate(input)).rejects.toThrow('status 429');
    const output = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(output.errors).toHaveLength(5);
    expect(output.errors[0].message).toHaveLength(512);
  });

  it('logs failed 2xx envelopes without changing the envelope error', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = new CloudflareWorkersAiImageAdapter(configuration, async () =>
      Response.json({ success: false, errors: [{ code: 3040, message: 'Out of capacity' }] }),
    );
    await expect(adapter.generate(input)).rejects.toThrow('response envelope is invalid');
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      http_status: 200,
      errors: [{ code: 3040 }],
    });
  });

  it('does not log successful requests', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = new CloudflareWorkersAiImageAdapter(configuration, async () =>
      Response.json({
        success: true,
        result: { image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') },
      }),
    );
    await expect(adapter.generate(input)).resolves.toMatchObject({ providerCode: 'cloudflare' });
    expect(log).not.toHaveBeenCalled();
  });
});
