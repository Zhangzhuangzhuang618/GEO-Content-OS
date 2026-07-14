import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MockOcrProvider } from './mock-ocr.provider.js';
import { createOcrAdapter, ProviderOcrAdapter } from './ocr.adapter.js';
import { OcrAdapterError, OcrProviderError } from './ocr.errors.js';
import type {
  OcrConfiguration,
  OcrPageInput,
  OcrProvider,
  OcrProviderResponse,
  OcrRecognizeInput,
} from './index.js';

const configuration: OcrConfiguration = {
  driver: 'mock',
  maxBytes: 1_024,
  maxCharacters: 10_000,
  maxPages: 10,
  timeoutMs: 500,
};

describe('OCR Adapter', () => {
  it('returns deterministic, traceable page blocks and settled usage', async () => {
    const first = imagePage(1, 'first');
    const second = imagePage(3, 'second');
    const adapter = new ProviderOcrAdapter(
      configuration,
      new MockOcrProvider({
        textByContentHash: {
          [first.contentHash]: '第一行',
          [second.contentHash]: '第二页',
        },
      }),
    );

    const result = await adapter.recognize(input([first, second]));

    expect(result).toMatchObject({
      adapterVersion: 'ocr-adapter/1.0.0',
      text: '第一行\n\n第二页',
      usage: {
        billablePages: 2,
        inputBytes: first.body.byteLength + second.body.byteLength,
        inputPages: 2,
        modelId: 'mock-ocr-v1',
        providerCode: 'mock',
        providerRequestId: 'mock-req-ocr-00000001',
        status: 'settled',
        unit: 'page',
      },
    });
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 3]);
    expect(result.pages[0]?.blocks[0]).toMatchObject({
      boundingBox: { height: 0.8, width: 0.8, x: 0.1, y: 0.1 },
      confidence: 1,
      kind: 'paragraph',
      readingOrder: 0,
      text: '第一行',
    });
    expect(result.textHash).toBe(createHash('sha256').update(result.text).digest('hex'));
    expect(Object.isFrozen(result.pages[0]?.blocks[0]?.boundingBox)).toBe(true);
  });

  it('normalizes provider text and enforces reading order', async () => {
    const page = imagePage(1, 'ordering');
    const adapter = new ProviderOcrAdapter(
      configuration,
      provider(async () => ({
        billablePages: 1,
        pages: [
          {
            blocks: [block(2, ' 后\r\n一行 '), block(0, '前\t一行')],
            height: 1_200,
            pageNumber: 1,
            width: 800,
          },
        ],
        providerRequestId: 'provider-request-1',
      })),
    );

    const result = await adapter.recognize(input([page]));

    expect(result.pages[0]?.text).toBe('前 一行\n后\n一行');
    expect(result.pages[0]?.blocks.map((entry) => entry.readingOrder)).toEqual([0, 2]);
  });

  it('rejects bad hashes, MIME signatures, ordering, language hints, and size before provider use', async () => {
    let calls = 0;
    const adapter = new ProviderOcrAdapter(
      { ...configuration, maxBytes: 12 },
      provider(async () => {
        calls += 1;
        throw new Error('must not run');
      }),
    );
    const valid = imagePage(1, 'too-large');
    const invalidCases: OcrRecognizeInput[] = [
      input([{ ...valid, contentHash: '0'.repeat(64) }]),
      input([{ ...valid, mimeType: 'image/jpeg' }]),
      input([imagePage(2, 'a'), imagePage(1, 'b')]),
      { ...input([valid]), languageHints: ['not_a_language'] },
      input([valid]),
    ];

    for (const invalid of invalidCases) {
      await expect(adapter.recognize(invalid)).rejects.toMatchObject({ code: 'OCR_INVALID_INPUT' });
    }
    expect(calls).toBe(0);
  });

  it('times out, aborts the provider, and reports unknown usage without leaking details', async () => {
    let observedAbort = false;
    const slowProvider: OcrProvider = {
      modelId: 'slow-model',
      providerCode: 'slow-provider',
      recognize: async (_request, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              reject(new Error('secret provider timeout detail'));
            },
            { once: true },
          );
        }),
    };
    const adapter = new ProviderOcrAdapter({ ...configuration, timeoutMs: 100 }, slowProvider);

    const error = await adapter.recognize(input([imagePage(1, 'slow')])).catch((value) => value);

    expect(error).toBeInstanceOf(OcrAdapterError);
    expect(error).toMatchObject({
      code: 'OCR_TIMEOUT',
      message: 'OCR provider exceeded the configured timeout',
      retryable: true,
      usage: {
        billablePages: null,
        inputPages: 1,
        modelId: 'slow-model',
        providerCode: 'slow-provider',
        providerRequestId: null,
        status: 'unknown',
      },
    });
    expect(observedAbort).toBe(true);
    expect(String(error)).not.toContain('secret');
  });

  it('distinguishes caller cancellation from provider timeout', async () => {
    const controller = new AbortController();
    const adapter = new ProviderOcrAdapter(configuration, new MockOcrProvider({ latencyMs: 200 }));
    const request = adapter.recognize({
      ...input([imagePage(1, 'cancel')]),
      signal: controller.signal,
    });
    controller.abort(new Error('caller stopped'));

    await expect(request).rejects.toMatchObject({
      code: 'OCR_CANCELLED',
      retryable: false,
      usage: { status: 'unknown' },
    });
  });

  it('preserves provider-declared usage on sanitized provider failures', async () => {
    const adapter = new ProviderOcrAdapter(
      configuration,
      provider(async () => {
        throw new OcrProviderError('credential=do-not-leak', {
          billablePages: 1,
          providerRequestId: 'provider-request-failed',
          retryable: false,
        });
      }),
    );

    const error = await adapter.recognize(input([imagePage(1, 'failure')])).catch((value) => value);

    expect(error).toMatchObject({
      code: 'OCR_PROVIDER_FAILED',
      message: 'OCR provider request failed',
      retryable: false,
      usage: {
        billablePages: 1,
        providerRequestId: 'provider-request-failed',
        status: 'settled',
      },
    });
    expect(String(error)).not.toContain('credential');
  });

  it('marks malformed provider failure usage unknown', async () => {
    const adapter = new ProviderOcrAdapter(
      configuration,
      provider(async () => {
        throw new OcrProviderError('bad usage', {
          billablePages: Number.NaN,
          providerRequestId: 'bad request id',
        });
      }),
    );

    await expect(adapter.recognize(input([imagePage(1, 'bad-usage')]))).rejects.toMatchObject({
      code: 'OCR_PROVIDER_FAILED',
      usage: { billablePages: null, providerRequestId: null, status: 'unknown' },
    });
  });

  it('rejects out-of-range direct configuration', () => {
    expect(
      () => new ProviderOcrAdapter({ ...configuration, timeoutMs: 99 }, new MockOcrProvider()),
    ).toThrow(TypeError);
  });

  it('rejects malformed provider geometry, duplicate order, missing pages, and empty OCR', async () => {
    const page = imagePage(1, 'bad-response');
    const badResponses: OcrProviderResponse[] = [
      { billablePages: 1, pages: [], providerRequestId: 'provider-request-1' },
      {
        billablePages: 1,
        pages: [providerPage([block(0, 'one'), block(0, 'two')])],
        providerRequestId: 'provider-request-2',
      },
      {
        billablePages: 1,
        pages: [
          providerPage([
            { ...block(0, 'outside'), boundingBox: { height: 1, width: 1, x: 0.1, y: 0 } },
          ]),
        ],
        providerRequestId: 'provider-request-3',
      },
      {
        billablePages: 1,
        pages: [providerPage([])],
        providerRequestId: 'provider-request-4',
      },
    ];

    for (const response of badResponses) {
      const adapter = new ProviderOcrAdapter(
        configuration,
        provider(async () => response),
      );
      await expect(adapter.recognize(input([page]))).rejects.toMatchObject({
        code: 'OCR_RESPONSE_INVALID',
        usage: { billablePages: 1, status: 'settled' },
      });
    }
  });

  it('fails closed when OCR is disabled', async () => {
    const adapter = createOcrAdapter({ ...configuration, driver: 'disabled' });
    await expect(adapter.recognize(input([imagePage(1, 'disabled')]))).rejects.toMatchObject({
      code: 'OCR_UNAVAILABLE',
      retryable: false,
    });
  });
});

function input(pages: readonly OcrPageInput[]): OcrRecognizeInput {
  return {
    languageHints: ['zh-CN', 'en'],
    pages,
    requestId: 'req-ocr-00000001',
  };
}

function imagePage(pageNumber: number, payload: string): OcrPageInput {
  const body = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(payload),
  ]);
  return {
    body,
    contentHash: createHash('sha256').update(body).digest('hex'),
    mimeType: 'image/png',
    pageNumber,
  };
}

function provider(
  recognize: OcrProvider['recognize'],
  descriptor: { readonly modelId?: string; readonly providerCode?: string } = {},
): OcrProvider {
  return {
    modelId: descriptor.modelId ?? 'test-model',
    providerCode: descriptor.providerCode ?? 'test-provider',
    recognize,
  };
}

function block(readingOrder: number, text: string) {
  return {
    boundingBox: { height: 0.2, width: 0.8, x: 0.1, y: 0.1 },
    confidence: 0.9,
    kind: 'line' as const,
    readingOrder,
    text,
  };
}

function providerPage(blocks: ReturnType<typeof block>[]) {
  return { blocks, height: 1_000, pageNumber: 1, width: 1_000 };
}
