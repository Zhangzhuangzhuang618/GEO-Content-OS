import { createHash } from 'node:crypto';

import { BaijiahaoDeliveryError } from './errors.js';
import { BaijiahaoDeliveryInputSchema } from './schema.js';
import {
  BAIJIAHAO_EXPORT_SCHEMA_VERSION,
  type BaijiahaoDeliveryInput,
  type BaijiahaoExportBundle,
  type BaijiahaoExportFile,
} from './types.js';

export function hashBaijiahaoPayload(payload: BaijiahaoDeliveryInput['payload']): string {
  return sha256(stableStringify(payload));
}

export function exportBaijiahao(input: unknown): BaijiahaoExportBundle {
  const parsed = BaijiahaoDeliveryInputSchema.parse(input) as BaijiahaoDeliveryInput;
  const actualHash = hashBaijiahaoPayload(parsed.payload);
  if (actualHash !== parsed.payload_hash) {
    throw new BaijiahaoDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Baijiahao payload hash does not match the frozen publish input',
    );
  }

  const basePath = parsed.content_version_id;
  const metadata = {
    abstract: parsed.payload.abstract,
    body_asset_ids: parsed.payload.body_asset_ids,
    citation_links: parsed.payload.citation_links,
    content_type: parsed.payload.content_type,
    cover_asset_id: parsed.payload.cover_asset_id,
    platform_code: 'baijiahao',
    rule_version: parsed.payload.rule_version,
    schema_version: parsed.payload.schema_version,
    tags: parsed.payload.tags,
    title: parsed.payload.title,
  };
  const contentFiles = [
    file(`${basePath}/article.html`, 'text/html; charset=utf-8', parsed.payload.body_html),
    file(`${basePath}/article.txt`, 'text/plain; charset=utf-8', parsed.payload.body_text),
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
    platform_code: 'baijiahao',
    rule_version: parsed.payload.rule_version,
    schema_version: BAIJIAHAO_EXPORT_SCHEMA_VERSION,
  })}\n`;
  return Object.freeze({
    content_version_id: parsed.content_version_id,
    files: Object.freeze([
      ...contentFiles,
      file(`${basePath}/manifest.json`, 'application/json', manifestBody),
    ]),
    payload_hash: parsed.payload_hash,
    platform_code: 'baijiahao',
    schema_version: BAIJIAHAO_EXPORT_SCHEMA_VERSION,
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

function file(path: string, contentType: string, body: string): BaijiahaoExportFile {
  return Object.freeze({ body, content_type: contentType, path, sha256: sha256(body) });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
