import { createHash } from 'node:crypto';

import { XiaohongshuDeliveryError } from './errors.js';
import { XiaohongshuDeliveryInputSchema } from './schema.js';
import {
  XIAOHONGSHU_EXPORT_SCHEMA_VERSION,
  type XiaohongshuDeliveryInput,
  type XiaohongshuExportBundle,
  type XiaohongshuExportFile,
} from './types.js';

export function hashXiaohongshuPayload(payload: XiaohongshuDeliveryInput['payload']): string {
  return sha256(stableStringify(payload));
}

export function exportXiaohongshu(input: unknown): XiaohongshuExportBundle {
  const parsed = XiaohongshuDeliveryInputSchema.parse(input) as XiaohongshuDeliveryInput;
  if (hashXiaohongshuPayload(parsed.payload) !== parsed.payload_hash) {
    throw new XiaohongshuDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Xiaohongshu payload hash does not match the frozen publish input',
    );
  }
  const basePath = parsed.content_version_id;
  const metadata = {
    citation_links: parsed.payload.citation_links,
    cover_text: parsed.payload.cover_text,
    note_type: parsed.payload.note_type,
    platform_code: 'xiaohongshu',
    rule_version: parsed.payload.rule_version,
    schema_version: parsed.payload.schema_version,
    title: parsed.payload.title,
    topics: parsed.payload.topics,
  };
  const contentFiles = [
    file(`${basePath}/note.html`, 'text/html; charset=utf-8', parsed.payload.body_html),
    file(`${basePath}/note.txt`, 'text/plain; charset=utf-8', parsed.payload.body_text),
    file(`${basePath}/metadata.json`, 'application/json', `${stableStringify(metadata)}\n`),
  ];
  const manifestBody = `${stableStringify({
    content_version_id: parsed.content_version_id,
    files: contentFiles.map(({ content_type, path, sha256: fileHash }) => ({
      content_type,
      path,
      sha256: fileHash,
    })),
    payload_hash: parsed.payload_hash,
    platform_code: 'xiaohongshu',
    rule_version: parsed.payload.rule_version,
    schema_version: XIAOHONGSHU_EXPORT_SCHEMA_VERSION,
  })}\n`;
  return Object.freeze({
    content_version_id: parsed.content_version_id,
    files: Object.freeze([
      ...contentFiles,
      file(`${basePath}/manifest.json`, 'application/json', manifestBody),
    ]),
    payload_hash: parsed.payload_hash,
    platform_code: 'xiaohongshu',
    schema_version: XIAOHONGSHU_EXPORT_SCHEMA_VERSION,
  });
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
function file(path: string, contentType: string, body: string): XiaohongshuExportFile {
  return Object.freeze({ body, content_type: contentType, path, sha256: sha256(body) });
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
