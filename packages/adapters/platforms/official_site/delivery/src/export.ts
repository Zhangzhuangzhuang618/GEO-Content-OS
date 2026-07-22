import { createHash } from 'node:crypto';

import { OfficialSiteDeliveryError } from './errors.js';
import { OfficialSiteDeliveryInputSchema } from './schema.js';
import {
  OFFICIAL_SITE_EXPORT_SCHEMA_VERSION,
  type OfficialSiteDeliveryInput,
  type OfficialSiteApiPayload,
  type OfficialSiteExportBundle,
  type OfficialSiteExportFile,
} from './types.js';

export function hashOfficialSitePayload(payload: OfficialSiteDeliveryInput['payload']): string {
  return sha256(stableStringify(toOfficialSiteApiPayload(payload)));
}

export function toOfficialSiteApiPayload(
  payload: OfficialSiteDeliveryInput['payload'],
): OfficialSiteApiPayload {
  return Object.freeze({
    body_html: payload.body_html,
    meta_description: payload.meta_description,
    platform_code: 'official_site',
    schema_version: 'zhiyuan-news-payload@1',
    seo_keywords: Object.freeze([...payload.seo_keywords]),
    summary: payload.summary,
    title: payload.title,
  });
}

export function exportOfficialSite(input: unknown): OfficialSiteExportBundle {
  const parsed = OfficialSiteDeliveryInputSchema.parse(input) as OfficialSiteDeliveryInput;
  const actualHash = hashOfficialSitePayload(parsed.payload);
  if (actualHash !== parsed.payload_hash) {
    throw new OfficialSiteDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Official site payload hash does not match the frozen publish input',
    );
  }

  const basePath = parsed.payload.slug;
  const contentFiles = [
    file(`${basePath}/index.html`, 'text/html; charset=utf-8', parsed.payload.html),
    file(`${basePath}/index.md`, 'text/markdown; charset=utf-8', parsed.payload.markdown),
    file(
      `${basePath}/schema-org.json`,
      'application/ld+json',
      `${stableStringify(parsed.payload.schema_org)}\n`,
    ),
  ];
  const manifestBody = `${stableStringify({
    content_version_id: parsed.content_version_id,
    files: contentFiles.map(({ content_type, path, sha256: fileHash }) => ({
      content_type,
      path,
      sha256: fileHash,
    })),
    payload_hash: parsed.payload_hash,
    platform_code: 'official_site',
    rule_version: parsed.payload.rule_version,
    schema_version: OFFICIAL_SITE_EXPORT_SCHEMA_VERSION,
    slug: parsed.payload.slug,
  })}\n`;
  return Object.freeze({
    files: Object.freeze([
      ...contentFiles,
      file(`${basePath}/manifest.json`, 'application/json', manifestBody),
    ]),
    payload_hash: parsed.payload_hash,
    platform_code: 'official_site',
    schema_version: OFFICIAL_SITE_EXPORT_SCHEMA_VERSION,
    slug: parsed.payload.slug,
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

function file(path: string, contentType: string, body: string): OfficialSiteExportFile {
  return Object.freeze({ body, content_type: contentType, path, sha256: sha256(body) });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
