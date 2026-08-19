import type { OcrAdapter } from '@geo-content-os/adapter-ocr';
import { MaterialParser } from '@geo-content-os/parsers';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { IngestSource } from './ingest.types.js';
import { MaterialIngestParser } from './material.ingest-parser.js';

describe('material ingest parser', () => {
  it('indexes manually confirmed certificate facts without invoking OCR', async () => {
    const body = new Uint8Array([1, 2, 3]);
    const contentHash = createHash('sha256').update(body).digest('hex');
    let ocrCalls = 0;
    const ocr: OcrAdapter = {
      recognize: async () => {
        ocrCalls += 1;
        throw new Error('OCR must not be used for structured certificate material');
      },
    };
    const source: IngestSource = {
      contentHash,
      id: '53000000-0000-4000-8000-000000000041',
      language: 'zh-CN',
      metadata: {
        article_use_allowed: true,
        certificate_name: '道路运输经营许可证',
        certificate_number: '粤交运管许可字 2026-001',
        holder_name: '广州示例搬家服务有限公司',
        issuing_authority: '广州市交通运输局',
        public_display_confirmed: true,
        schema_version: 'source-certificate@1',
        verification_url: 'https://example.gov.cn/verify/2026-001',
      },
      mimeType: 'image/png',
      sourceType: 'image',
      status: 'processing',
      tenantId: '23000000-0000-4000-8000-000000000041',
      title: '企业运输证照',
      workspaceId: '33000000-0000-4000-8000-000000000041',
    };
    const parsed = await new MaterialIngestParser(new MaterialParser(), ocr).parse(
      source,
      { body, contentHash, mimeType: 'image/png' },
      'ingest-73000000-0000-4000-8000-000000000041',
    );

    expect(ocrCalls).toBe(0);
    expect(parsed.text).toContain('证照编号：粤交运管许可字 2026-001');
    expect(parsed.text).toContain('持证主体：广州示例搬家服务有限公司');
    expect(parsed.units[0]?.locator.url).toBe('https://example.gov.cn/verify/2026-001');
  });

  it('turns image OCR into exact page and character provenance', async () => {
    const text = '图像中的可信事实';
    const body = new Uint8Array([1, 2, 3]);
    const contentHash = createHash('sha256').update(body).digest('hex');
    const ocr: OcrAdapter = {
      recognize: async () => ({
        adapterVersion: 'ocr-adapter/1.0.0',
        pages: [
          {
            blocks: [],
            height: 100,
            pageNumber: 1,
            text,
            width: 100,
          },
        ],
        text,
        textHash: createHash('sha256').update(text).digest('hex'),
        usage: {
          billablePages: 1,
          durationMs: 1,
          inputBytes: body.byteLength,
          inputPages: 1,
          modelId: 'mock-ocr',
          providerCode: 'mock',
          providerRequestId: 'mock-request',
          status: 'settled',
          unit: 'page',
        },
      }),
    };
    const source: IngestSource = {
      contentHash,
      id: '53000000-0000-4000-8000-000000000040',
      language: 'zh-CN',
      mimeType: 'image/png',
      metadata: {},
      sourceType: 'image',
      status: 'processing',
      tenantId: '23000000-0000-4000-8000-000000000040',
      title: 'OCR source',
      workspaceId: '33000000-0000-4000-8000-000000000040',
    };
    const parsed = await new MaterialIngestParser(new MaterialParser(), ocr).parse(
      source,
      { body, contentHash, mimeType: 'image/png' },
      'ingest-73000000-0000-4000-8000-000000000040',
    );
    expect(parsed).toMatchObject({
      content_hash: contentHash,
      metadata: { page_count: 1, source_type: 'image' },
      text,
      units: [
        {
          locator: { char_end: text.length, char_start: 0, page: 1, url: null },
          text,
          text_hash: createHash('sha256').update(text).digest('hex'),
        },
      ],
    });
    expect(
      parsed.text.slice(parsed.units[0]!.locator.char_start, parsed.units[0]!.locator.char_end),
    ).toBe(text);
  });
});
