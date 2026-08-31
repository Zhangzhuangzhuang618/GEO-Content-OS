import type { OcrAdapter } from '@geo-content-os/adapter-ocr';
import { MaterialParser } from '@geo-content-os/parsers';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { IngestSource } from './ingest.types.js';
import { MaterialIngestParser } from './material.ingest-parser.js';

describe('material ingest parser', () => {
  it('indexes only the confirmed insurance summary and never parses the private PDF body', async () => {
    const privateBody = new TextEncoder().encode(
      '%PDF-1.7 employee=张三 id=440101199001011234 phone=13800138000',
    );
    const contentHash = createHash('sha256').update(privateBody).digest('hex');
    let ocrCalls = 0;
    const ocr: OcrAdapter = {
      recognize: async () => {
        ocrCalls += 1;
        throw new Error('OCR must not be used for private insurance proof originals');
      },
    };
    const source: IngestSource = {
      contentHash,
      effectiveFrom: '2026-01-10',
      effectiveTo: '2027-01-09',
      id: '53000000-0000-4000-8000-000000000042',
      language: 'zh-CN',
      metadata: {
        insurance_type: '团体员工福利保险',
        insured_count: 11,
        insurer_name: '示例人寿保险有限公司',
        policyholder_name: '广州示例搬家服务有限公司',
        schema_version: 'source-insurance-proof@1',
        summary_use_confirmed: true,
      },
      mimeType: 'application/pdf',
      sourceType: 'pdf',
      status: 'processing',
      tenantId: '23000000-0000-4000-8000-000000000042',
      title: '企业团体保险证明',
      workspaceId: '33000000-0000-4000-8000-000000000042',
    };
    const parser = new MaterialIngestParser(new MaterialParser(), ocr);
    const parsed = await parser.parse(
      source,
      { body: privateBody, contentHash, mimeType: 'application/pdf' },
      'ingest-73000000-0000-4000-8000-000000000042',
    );

    expect(ocrCalls).toBe(0);
    expect(parsed.title).toBe('企业保险证明');
    expect(parsed.text).toContain('投保主体：广州示例搬家服务有限公司');
    expect(parsed.text).toContain('参保人数：11人');
    expect(parsed.text).not.toContain('用途边界');
    expect(parsed.text).not.toContain('不代表理赔结果');
    expect(parsed.text).not.toContain('张三');
    expect(parsed.text).not.toContain('440101199001011234');
    expect(parsed.text).not.toContain('13800138000');
    expect(parsed.metadata).toEqual({ page_count: null, source_type: 'pdf' });
    await expect(
      parser.parse(
        {
          ...source,
          metadata: { ...source.metadata, policyholder_name: '示例企业 13800138000' },
        },
        { body: privateBody, contentHash, mimeType: 'application/pdf' },
        'ingest-73000000-0000-4000-8000-000000000043',
      ),
    ).rejects.toMatchObject({ code: 'INSURANCE_PROOF_METADATA_INVALID', retryable: false });
    expect(ocrCalls).toBe(0);
  });

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
      effectiveFrom: null,
      effectiveTo: null,
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
      effectiveFrom: null,
      effectiveTo: null,
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
