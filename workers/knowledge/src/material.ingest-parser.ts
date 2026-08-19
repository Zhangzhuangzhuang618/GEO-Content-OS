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
    const insuranceProof = insuranceProofMetadata(source);
    if (insuranceProof) return insuranceProofDocument(source, material, insuranceProof);
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

interface InsuranceProofMetadata {
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
  readonly insuranceType: string;
  readonly insuredCount: number;
  readonly insurerName: string;
  readonly policyholderName: string;
}

function insuranceProofMetadata(source: IngestSource): InsuranceProofMetadata | null {
  const value = source.metadata;
  if (value['schema_version'] !== 'source-insurance-proof@1') return null;
  const insurerName = text(value['insurer_name']);
  const policyholderName = text(value['policyholder_name']);
  const insuranceType = text(value['insurance_type']);
  const insuredCount = value['insured_count'];
  if (
    source.sourceType !== 'pdf' ||
    source.mimeType !== 'application/pdf' ||
    !source.effectiveFrom ||
    !source.effectiveTo ||
    !insurerName ||
    !policyholderName ||
    !insuranceType ||
    [insurerName, policyholderName, insuranceType].some(containsSensitiveIdentifier) ||
    typeof insuredCount !== 'number' ||
    !Number.isSafeInteger(insuredCount) ||
    insuredCount < 1 ||
    insuredCount > 100_000 ||
    value['summary_use_confirmed'] !== true
  ) {
    throw new IngestWorkerError(
      'INSURANCE_PROOF_METADATA_INVALID',
      'Insurance proof metadata is incomplete or invalid',
      { retryable: false },
    );
  }
  return {
    effectiveFrom: source.effectiveFrom,
    effectiveTo: source.effectiveTo,
    insuranceType,
    insuredCount,
    insurerName,
    policyholderName,
  };
}

function containsSensitiveIdentifier(value: string): boolean {
  return (
    /(^|\D)1[3-9][0-9]{9}(\D|$)/u.test(value) ||
    /(^|[^0-9A-Za-z])[0-9]{17}[0-9Xx]([^0-9A-Za-z]|$)/u.test(value) ||
    /(^|\D)[0-9]{16,19}(\D|$)/u.test(value) ||
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u.test(value)
  );
}

function insuranceProofDocument(
  source: IngestSource,
  material: LoadedMaterial,
  proof: InsuranceProofMetadata,
): ParsedMaterialDocument {
  const textValue = [
    '资料类型：企业保险证明',
    `投保主体：${proof.policyholderName}`,
    `承保机构：${proof.insurerName}`,
    `保险类型：${proof.insuranceType}`,
    `保障期间：${proof.effectiveFrom} 至 ${proof.effectiveTo}`,
    `参保人数：${proof.insuredCount}人`,
    '用途边界：该资料仅证明上述企业投保事实、保险类型、保障期间和参保人数，不代表服务质量、理赔结果或到期后的持续有效性。',
  ].join('\n');
  return Object.freeze({
    content_hash: material.contentHash,
    language: source.language,
    metadata: Object.freeze({ page_count: null, source_type: 'pdf' as const }),
    parser_version: MATERIAL_PARSER_VERSION,
    text: textValue,
    title: '企业保险证明',
    units: Object.freeze([
      Object.freeze({
        locator: Object.freeze({
          char_end: textValue.length,
          char_start: 0,
          headings: Object.freeze([]),
          page: null,
          url: null,
        }),
        text: textValue,
        text_hash: sha256(textValue),
      }),
    ]),
    warnings: Object.freeze([]),
  });
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
