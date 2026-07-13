import { createHash } from 'node:crypto';

import type { JsonValue, RequestFingerprint } from './idempotency.types.js';

export function hashRequest(fingerprint: RequestFingerprint): string {
  const normalized = {
    body: fingerprint.body ?? null,
    method: fingerprint.method.trim().toUpperCase(),
    path: fingerprint.path.trim(),
    query: fingerprint.query ?? null,
  } satisfies JsonValue;

  if (!normalized.method || !normalized.path) {
    throw new Error('Request fingerprint method and path are required');
  }

  return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex');
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Request fingerprint contains a non-finite number');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`)
    .join(',')}}`;
}
