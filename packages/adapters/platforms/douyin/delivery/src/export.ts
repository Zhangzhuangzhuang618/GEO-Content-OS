import { createHash } from 'node:crypto';

import { DouyinDeliveryError } from './errors.js';
import { DouyinDeliveryInputSchema } from './schema.js';
import {
  DOUYIN_EXPORT_SCHEMA_VERSION,
  type DouyinDeliveryInput,
  type DouyinExportBundle,
  type DouyinExportFile,
} from './types.js';

export function hashDouyinPayload(payload: DouyinDeliveryInput['payload']): string {
  return sha256(stableStringify(payload));
}

export function exportDouyin(input: unknown): DouyinExportBundle {
  const parsed = DouyinDeliveryInputSchema.parse(input) as DouyinDeliveryInput;
  if (hashDouyinPayload(parsed.payload) !== parsed.payload_hash) {
    throw new DouyinDeliveryError(
      'PAYLOAD_HASH_MISMATCH',
      'Douyin payload hash does not match the frozen publish input',
    );
  }
  const basePath = parsed.content_version_id;
  const metadata = {
    citation_links: parsed.payload.citation_links,
    duration_seconds: parsed.payload.duration_seconds,
    hook: parsed.payload.hook,
    platform_code: 'douyin',
    rule_version: parsed.payload.rule_version,
    schema_version: parsed.payload.schema_version,
    script_kind: parsed.payload.script_kind,
    title: parsed.payload.title,
    topics: parsed.payload.topics,
  };
  const contentFiles = [
    file(`${basePath}/script.json`, 'application/json', `${stableStringify(parsed.payload)}\n`),
    file(`${basePath}/script.txt`, 'text/plain; charset=utf-8', parsed.payload.script_text),
    file(
      `${basePath}/subtitles.srt`,
      'application/x-subrip; charset=utf-8',
      renderSrt(parsed.payload.subtitles),
    ),
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
    platform_code: 'douyin',
    rule_version: parsed.payload.rule_version,
    schema_version: DOUYIN_EXPORT_SCHEMA_VERSION,
  })}\n`;
  return Object.freeze({
    content_version_id: parsed.content_version_id,
    files: Object.freeze([
      ...contentFiles,
      file(`${basePath}/manifest.json`, 'application/json', manifestBody),
    ]),
    payload_hash: parsed.payload_hash,
    platform_code: 'douyin',
    schema_version: DOUYIN_EXPORT_SCHEMA_VERSION,
  });
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}
function renderSrt(subtitles: DouyinDeliveryInput['payload']['subtitles']): string {
  return `${subtitles
    .map(
      (subtitle, index) =>
        `${index + 1}\n${srtTime(subtitle.start_second)} --> ${srtTime(subtitle.end_second)}\n${subtitle.text}`,
    )
    .join('\n\n')}\n`;
}
function srtTime(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(wholeSeconds, 2)},${pad(remainder, 3)}`;
}
function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
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
function file(path: string, contentType: string, body: string): DouyinExportFile {
  return Object.freeze({ body, content_type: contentType, path, sha256: sha256(body) });
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
