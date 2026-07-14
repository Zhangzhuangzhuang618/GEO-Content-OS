import { createHash } from 'node:crypto';

import type { PlatformCode } from '@geo-content-os/contracts';

import { GenerationWorkerError } from './generation.errors.js';
import type {
  ContentBlockType,
  GeneratedContent,
  GeneratedContentBlock,
} from './generation.types.js';

const BLOCK_KEY = /^[a-z0-9_-]{1,80}$/u;
const BLOCK_TYPES = new Set<ContentBlockType>([
  'cta',
  'heading',
  'list',
  'media',
  'paragraph',
  'quote',
]);

export function validateGeneratedContent(
  value: unknown,
  expectedPlatform: PlatformCode | 'master',
): GeneratedContent {
  if (!isRecord(value) || value.platform_code !== expectedPlatform) {
    throw invalidContent(`Generated content platform must be ${expectedPlatform}`);
  }
  if (
    typeof value.schema_version !== 'string' ||
    value.schema_version.trim().length < 1 ||
    value.schema_version.length > 32
  ) {
    throw invalidContent('Generated content schema version is invalid');
  }
  const candidates = value.blocks;
  if (!Array.isArray(candidates) || candidates.length < 1) {
    throw invalidContent('Generated content must contain at least one block');
  }
  const seen = new Set<string>();
  for (const [position, candidate] of candidates.entries()) {
    if (!isRecord(candidate)) throw invalidContent(`Block ${position} must be an object`);
    const key = candidate.block_key;
    const type = candidate.block_type;
    if (typeof key !== 'string' || !BLOCK_KEY.test(key) || seen.has(key)) {
      throw invalidContent(`Block ${position} has an invalid or duplicate key`);
    }
    if (typeof type !== 'string' || !BLOCK_TYPES.has(type as ContentBlockType)) {
      throw invalidContent(`Block ${key} has an invalid type`);
    }
    if (typeof candidate.text !== 'string') throw invalidContent(`Block ${key} text is invalid`);
    seen.add(key);
  }
  canonicalJson(value);
  return value as GeneratedContent;
}

export function contentBlocks(content: GeneratedContent): readonly GeneratedContentBlock[] {
  return content.blocks;
}

export function contentHash(content: GeneratedContent): string {
  return sha256(canonicalJson(content));
}

export function textHash(text: string): string {
  return sha256(text);
}

export function canonicalJson(value: unknown, path = '$'): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidContent(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], `${path}.${key}`)}`)
      .join(',')}}`;
  }
  throw invalidContent(`${path} contains a non-JSON value`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidContent(message: string): GenerationWorkerError {
  return new GenerationWorkerError('GENERATED_CONTENT_INVALID', message);
}
