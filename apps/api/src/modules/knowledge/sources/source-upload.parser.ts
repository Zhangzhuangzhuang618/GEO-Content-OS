import type {
  CertificateSourceMetadata,
  SourceDocumentMetadata,
  SourceTrustLevel,
  SourceType,
} from '../../../database/schema/index.js';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { sourceImageMetadata } from '@geo-content-os/adapter-image';
import type { FastifyRequest } from 'fastify';

import { SourceUploadValidationError } from './source.errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_CERTIFICATE_IMAGE_BYTES = 10_000_000;
const ALLOWED_FIELDS = new Set([
  'article_use_allowed',
  'certificate_name',
  'certificate_number',
  'effective_from',
  'effective_to',
  'holder_name',
  'issuing_authority',
  'language',
  'material_kind',
  'project_id',
  'public_display_confirmed',
  'title',
  'trust_level',
  'url',
  'verification_url',
  'workspace_id',
]);

interface ParsedSourceMetadata {
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly language: string;
  readonly metadata: SourceDocumentMetadata;
  readonly projectId: string | null;
  readonly title: string;
  readonly trustLevel: SourceTrustLevel;
  readonly workspaceId: string;
}

export interface ParsedFileSource extends ParsedSourceMetadata {
  readonly body: Buffer;
  readonly contentHash: string;
  readonly extension: string;
  readonly filename: string;
  readonly kind: 'file';
  readonly mimeType: string;
  readonly sourceType: Exclude<SourceType, 'url'>;
}

export interface ParsedUrlSource extends ParsedSourceMetadata {
  readonly body: Buffer;
  readonly contentHash: string;
  readonly finalUrl: string;
  readonly kind: 'url';
  readonly mimeType: string;
  readonly redirectChain: readonly string[];
  readonly sourceType: 'url';
}

export interface ParsedUrlSubmission extends ParsedSourceMetadata {
  readonly kind: 'url-submission';
  readonly requestedUrl: string;
}

export type ParsedSourceUpload = ParsedFileSource | ParsedUrlSource;
export type ParsedSourceSubmission = ParsedFileSource | ParsedUrlSubmission;

export async function parseSourceUpload(
  request: FastifyRequest,
  maxFileBytes: number,
): Promise<ParsedSourceSubmission> {
  if (!request.isMultipart()) {
    throw new SourceUploadValidationError('Content-Type must be multipart/form-data');
  }
  const fields = new Map<string, string>();
  let file:
    { readonly body: Buffer; readonly filename: string; readonly mimetype: string } | undefined;
  try {
    for await (const part of request.parts({
      limits: {
        fieldNameSize: 64,
        fieldSize: 8_192,
        fields: ALLOWED_FIELDS.size,
        fileSize: maxFileBytes,
        files: 1,
        parts: ALLOWED_FIELDS.size + 1,
      },
    })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file' || file) {
          part.file.resume();
          throw new SourceUploadValidationError('Exactly one file field named file is required');
        }
        const body = await part.toBuffer();
        if (part.file.truncated || body.byteLength > maxFileBytes) {
          throw new SourceUploadValidationError('Uploaded file exceeds the configured size limit');
        }
        file = { body, filename: part.filename, mimetype: part.mimetype.toLowerCase() };
        continue;
      }
      if (!ALLOWED_FIELDS.has(part.fieldname) || fields.has(part.fieldname)) {
        throw new SourceUploadValidationError(
          'Multipart form contains an unknown or duplicate field',
        );
      }
      if (part.valueTruncated || typeof part.value !== 'string') {
        throw new SourceUploadValidationError('Multipart fields must be non-truncated strings');
      }
      fields.set(part.fieldname, part.value.trim());
    }
  } catch (error) {
    if (error instanceof SourceUploadValidationError) throw error;
    if (isMultipartLimitError(error)) {
      throw new SourceUploadValidationError('Multipart upload exceeds the configured limits');
    }
    throw error;
  }
  const requestedUrl = fields.get('url');
  if (Boolean(file) === Boolean(requestedUrl)) {
    throw new SourceUploadValidationError('Exactly one non-empty file or url is required');
  }
  if (file && file.body.byteLength === 0) {
    throw new SourceUploadValidationError('Uploaded file must not be empty');
  }

  const workspaceId = requiredUuid(fields, 'workspace_id');
  const projectId = optionalUuid(fields, 'project_id');
  const title = required(fields, 'title');
  if (title.length > 240 || hasControlCharacter(title))
    throw new SourceUploadValidationError(
      'title must contain 1 to 240 characters without control characters',
    );
  const language = fields.get('language') || 'zh-CN';
  if (!LANGUAGE.test(language))
    throw new SourceUploadValidationError('language must be a BCP 47 tag');
  const trustLevel = parseTrustLevel(fields.get('trust_level'));
  const effectiveFrom = optionalDate(fields.get('effective_from'), 'effective_from');
  const effectiveTo = optionalDate(fields.get('effective_to'), 'effective_to');
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
    throw new SourceUploadValidationError('effective_to must be on or after effective_from');
  }
  const metadata = {
    effectiveFrom,
    effectiveTo,
    language,
    metadata: {} as const,
    projectId,
    title,
    trustLevel,
    workspaceId,
  } as const;
  if (!file) {
    requireDocumentMaterial(fields);
    if (!requestedUrl || requestedUrl.length > 2_048 || hasControlCharacter(requestedUrl)) {
      throw new SourceUploadValidationError('url must contain 1 to 2048 safe characters');
    }
    return { ...metadata, kind: 'url-submission', requestedUrl };
  }
  const detected = detectFile(file.body, file.mimetype, file.filename);
  const kind = materialKind(fields);
  if (detected.sourceType === 'image') await validateSourceImage(file.body, kind);
  const sourceMetadata =
    detected.sourceType === 'image' && kind === 'certificate'
      ? parseCertificateMetadata(fields)
      : (requireDocumentMaterial(fields), {} as const);
  if (
    trustLevel === 'untrusted' &&
    'article_use_allowed' in sourceMetadata &&
    sourceMetadata.article_use_allowed
  ) {
    throw new SourceUploadValidationError(
      'Untrusted certificate material cannot be authorized for article display',
    );
  }
  return {
    ...metadata,
    body: file.body,
    contentHash: createHash('sha256').update(file.body).digest('hex'),
    extension: detected.extension,
    filename: normalizeFilename(file.filename),
    kind: 'file',
    mimeType: detected.mimeType,
    metadata: sourceMetadata,
    sourceType: detected.sourceType,
  };
}

async function validateSourceImage(body: Buffer, kind: 'certificate' | 'document'): Promise<void> {
  try {
    if (kind === 'certificate' && body.byteLength > MAX_CERTIFICATE_IMAGE_BYTES) throw new Error();
    await sourceImageMetadata(body);
  } catch {
    throw new SourceUploadValidationError(
      `Source image must be decodable, at least 768x512, no more than 8192 pixels per side or 50 megapixels, and no larger than ${kind === 'certificate' ? '10 MB' : '25 MiB'}`,
    );
  }
}

function parseCertificateMetadata(fields: ReadonlyMap<string, string>): CertificateSourceMetadata {
  const articleUseAllowed = optionalBoolean(
    fields.get('article_use_allowed'),
    'article_use_allowed',
  );
  const publicDisplayConfirmed = optionalBoolean(
    fields.get('public_display_confirmed'),
    'public_display_confirmed',
  );
  if (articleUseAllowed && !publicDisplayConfirmed) {
    throw new SourceUploadValidationError(
      'public_display_confirmed is required before article use is allowed',
    );
  }
  return Object.freeze({
    article_use_allowed: articleUseAllowed,
    certificate_name: safeRequiredText(fields, 'certificate_name', 240),
    certificate_number: safeRequiredText(fields, 'certificate_number', 120),
    holder_name: safeRequiredText(fields, 'holder_name', 240),
    issuing_authority: safeRequiredText(fields, 'issuing_authority', 240),
    public_display_confirmed: publicDisplayConfirmed,
    schema_version: 'source-certificate@1',
    verification_url: optionalHttpsUrl(fields.get('verification_url')),
  });
}

function materialKind(fields: ReadonlyMap<string, string>): 'certificate' | 'document' {
  const value = fields.get('material_kind') || 'document';
  if (value !== 'certificate' && value !== 'document') {
    throw new SourceUploadValidationError('material_kind must be document or certificate');
  }
  return value;
}

function requireDocumentMaterial(fields: ReadonlyMap<string, string>): void {
  if (materialKind(fields) !== 'document') {
    throw new SourceUploadValidationError(
      'Certificate material requires a PNG, JPEG, or WebP image file',
    );
  }
  const certificateFields = [
    'article_use_allowed',
    'certificate_name',
    'certificate_number',
    'holder_name',
    'issuing_authority',
    'public_display_confirmed',
    'verification_url',
  ];
  if (certificateFields.some((name) => fields.has(name))) {
    throw new SourceUploadValidationError(
      'Certificate fields are only allowed for certificate image material',
    );
  }
}

function safeRequiredText(
  fields: ReadonlyMap<string, string>,
  name: string,
  maximum: number,
): string {
  const value = required(fields, name);
  if (value.length > maximum || hasControlCharacter(value)) {
    throw new SourceUploadValidationError(
      `${name} must contain 1 to ${maximum} characters without control characters`,
    );
  }
  return value;
}

function optionalBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new SourceUploadValidationError(`${name} must be true or false`);
}

function optionalHttpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length > 2_048 || hasControlCharacter(value)) {
    throw new SourceUploadValidationError('verification_url must be a safe HTTPS URL');
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
    return parsed.toString();
  } catch {
    throw new SourceUploadValidationError('verification_url must be a safe HTTPS URL');
  }
}

function detectFile(
  body: Buffer,
  declaredMime: string,
  filename: string,
): {
  readonly extension: string;
  readonly mimeType: string;
  readonly sourceType: Exclude<SourceType, 'url'>;
} {
  const lowerFilename = filename.toLowerCase();
  if (
    declaredMime === 'application/pdf' &&
    lowerFilename.endsWith('.pdf') &&
    body.subarray(0, 5).equals(Buffer.from('%PDF-'))
  ) {
    return { extension: 'pdf', mimeType: 'application/pdf', sourceType: 'pdf' };
  }
  if (
    declaredMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
    lowerFilename.endsWith('.docx') &&
    body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
    body.includes(Buffer.from('[Content_Types].xml')) &&
    body.includes(Buffer.from('word/'))
  ) {
    return {
      extension: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sourceType: 'docx',
    };
  }
  if (declaredMime === 'text/plain' && lowerFilename.endsWith('.txt') && isUtf8Text(body)) {
    return { extension: 'txt', mimeType: 'text/plain', sourceType: 'txt' };
  }
  if (
    declaredMime === 'image/png' &&
    lowerFilename.endsWith('.png') &&
    body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { extension: 'png', mimeType: 'image/png', sourceType: 'image' };
  }
  if (
    declaredMime === 'image/jpeg' &&
    /\.jpe?g$/u.test(lowerFilename) &&
    body[0] === 0xff &&
    body[1] === 0xd8 &&
    body.at(-2) === 0xff &&
    body.at(-1) === 0xd9
  ) {
    return { extension: 'jpg', mimeType: 'image/jpeg', sourceType: 'image' };
  }
  if (
    declaredMime === 'image/webp' &&
    lowerFilename.endsWith('.webp') &&
    body.subarray(0, 4).toString('ascii') === 'RIFF' &&
    body.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { extension: 'webp', mimeType: 'image/webp', sourceType: 'image' };
  }
  throw new SourceUploadValidationError(
    'File extension, declared MIME, and content signature must match an allowed type',
  );
}

function isUtf8Text(body: Buffer): boolean {
  if (body.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}

function required(fields: ReadonlyMap<string, string>, name: string): string {
  const value = fields.get(name);
  if (!value) throw new SourceUploadValidationError(`${name} is required`);
  return value;
}

function requiredUuid(fields: ReadonlyMap<string, string>, name: string): string {
  const value = required(fields, name);
  if (!UUID.test(value)) throw new SourceUploadValidationError(`${name} must be a UUID`);
  return value.toLowerCase();
}

function optionalUuid(fields: ReadonlyMap<string, string>, name: string): string | null {
  const value = fields.get(name);
  if (!value) return null;
  if (!UUID.test(value)) throw new SourceUploadValidationError(`${name} must be a UUID`);
  return value.toLowerCase();
}

function parseTrustLevel(value: string | undefined): SourceTrustLevel {
  const normalized = value || 'normal';
  if (!['verified', 'normal', 'untrusted'].includes(normalized)) {
    throw new SourceUploadValidationError('trust_level is invalid');
  }
  return normalized as SourceTrustLevel;
}

function optionalDate(value: string | undefined, name: string): string | null {
  if (!value) return null;
  if (!ISO_DATE.test(value)) throw new SourceUploadValidationError(`${name} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new SourceUploadValidationError(`${name} must be a real calendar date`);
  }
  return value;
}

function normalizeFilename(value: string): string {
  const normalized = Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();
  if (!normalized || normalized.length > 255) {
    throw new SourceUploadValidationError('filename must contain 1 to 255 safe characters');
  }
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function isMultipartLimitError(error: unknown): boolean {
  const code = (error as { readonly code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('FST_');
}
