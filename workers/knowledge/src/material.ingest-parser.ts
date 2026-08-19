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
    const certificate = certificateMetadata(source.metadata);
    if (certificate) return certificateDocument(source, material, certificate);
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

interface CertificateMetadata {
  readonly certificateName: string;
  readonly certificateNumber: string;
  readonly holderName: string;
  readonly issuingAuthority: string;
  readonly verificationUrl: string | null;
}

function certificateMetadata(value: Readonly<Record<string, unknown>>): CertificateMetadata | null {
  if (value['schema_version'] !== 'source-certificate@1') return null;
  const certificateName = text(value['certificate_name']);
  const certificateNumber = text(value['certificate_number']);
  const holderName = text(value['holder_name']);
  const issuingAuthority = text(value['issuing_authority']);
  const verificationUrl = value['verification_url'];
  if (!certificateName || !certificateNumber || !holderName || !issuingAuthority) return null;
  if (verificationUrl !== null && typeof verificationUrl !== 'string') return null;
  return { certificateName, certificateNumber, holderName, issuingAuthority, verificationUrl };
}

function certificateDocument(
  source: IngestSource,
  material: LoadedMaterial,
  certificate: CertificateMetadata,
): ParsedMaterialDocument {
  const textValue = [
    '资料类型：企业证照',
    `证照名称：${certificate.certificateName}`,
    `持证主体：${certificate.holderName}`,
    `证照编号：${certificate.certificateNumber}`,
    `发证机关：${certificate.issuingAuthority}`,
    ...(certificate.verificationUrl ? [`官方核验链接：${certificate.verificationUrl}`] : []),
  ].join('\n');
  return Object.freeze({
    content_hash: material.contentHash,
    language: source.language,
    metadata: Object.freeze({ page_count: 1, source_type: 'image' as const }),
    parser_version: MATERIAL_PARSER_VERSION,
    text: textValue,
    title: source.title,
    units: Object.freeze([
      Object.freeze({
        locator: Object.freeze({
          char_end: textValue.length,
          char_start: 0,
          headings: Object.freeze([]),
          page: 1,
          url: certificate.verificationUrl,
        }),
        text: textValue,
        text_hash: sha256(textValue),
      }),
    ]),
    warnings: Object.freeze([]),
  });
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isOcrMime(value: string): value is OcrMimeType {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
