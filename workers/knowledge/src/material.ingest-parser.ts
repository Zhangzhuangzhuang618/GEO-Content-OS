import { createHash } from 'node:crypto';

import type { OcrAdapter, OcrMimeType } from '@geo-content-os/adapter-ocr';
import {
  MATERIAL_PARSER_VERSION,
  type MaterialParser,
  type ParsedMaterialDocument,
} from '@geo-content-os/parsers';

import { IngestWorkerError } from './ingest.errors.js';
import type { IngestParserPort, IngestSource, LoadedMaterial } from './ingest.types.js';

export class MaterialIngestParser implements IngestParserPort {
  public constructor(
    private readonly parser: MaterialParser,
    private readonly ocr: OcrAdapter,
  ) {}

  public async parse(
    source: IngestSource,
    material: LoadedMaterial,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ParsedMaterialDocument> {
    if (source.sourceType !== 'image') {
      return this.parser.parse({
        body: material.body,
        contentHash: material.contentHash,
        language: source.language,
        mimeType: material.mimeType,
        sourceType: source.sourceType,
        title: source.title,
        ...(material.url ? { url: material.url } : {}),
      });
    }
    if (!isOcrMime(material.mimeType)) {
      throw new IngestWorkerError('OCR_MIME_INVALID', 'Image MIME type is not supported by OCR', {
        retryable: false,
      });
    }
    const result = await this.ocr.recognize({
      languageHints: [source.language],
      pages: [
        {
          body: material.body,
          contentHash: material.contentHash,
          mimeType: material.mimeType,
          pageNumber: 1,
        },
      ],
      requestId,
      ...(signal ? { signal } : {}),
    });
    let offset = 0;
    const units = result.pages.map((page, index) => {
      if (index > 0) offset += 2;
      const charStart = offset;
      offset += page.text.length;
      return Object.freeze({
        locator: Object.freeze({
          char_end: offset,
          char_start: charStart,
          headings: Object.freeze([]),
          page: page.pageNumber,
          url: null,
        }),
        text: page.text,
        text_hash: sha256(page.text),
      });
    });
    return Object.freeze({
      content_hash: material.contentHash,
      language: source.language,
      metadata: Object.freeze({ page_count: result.pages.length, source_type: 'image' as const }),
      parser_version: MATERIAL_PARSER_VERSION,
      text: result.text,
      title: source.title,
      units: Object.freeze(units),
      warnings: Object.freeze([]),
    });
  }
}

function isOcrMime(value: string): value is OcrMimeType {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
