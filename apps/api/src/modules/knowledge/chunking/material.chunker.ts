import { createHash } from 'node:crypto';

import { ChunkingError } from './chunker.errors.js';
import {
  CHUNKER_VERSION,
  type ChunkableMaterialDocument,
  type ChunkingPolicy,
  type SourceChunkDraft,
} from './chunker.types.js';

export const FROZEN_CHUNKING_POLICY: ChunkingPolicy = Object.freeze({
  maxTokens: 900,
  minTokens: 500,
  overlapTokens: 80,
  targetTokens: 700,
});

interface TokenSpan {
  readonly end: number;
  readonly start: number;
}

interface LocatorGroup {
  readonly end: number;
  readonly page: number | null;
  readonly start: number;
  readonly units: ChunkableMaterialDocument['units'];
  readonly url: string | null;
}

const TOKEN_PATTERN = /[\p{Script=Han}]|[\p{L}\p{M}\p{N}]+(?:['’._-][\p{L}\p{M}\p{N}]+)*|[^\s]/gu;

export class MaterialChunker {
  private readonly policy: ChunkingPolicy;

  public constructor(policy: Partial<ChunkingPolicy> = {}) {
    this.policy = validatePolicy({ ...FROZEN_CHUNKING_POLICY, ...policy });
  }

  public chunk(document: ChunkableMaterialDocument): readonly SourceChunkDraft[] {
    validateDocument(document);
    const drafts: SourceChunkDraft[] = [];
    for (const group of locatorGroups(document)) {
      const tokens = tokenize(document.text.slice(group.start, group.end), group.start);
      if (tokens.length === 0) continue;
      let startToken = 0;
      while (startToken < tokens.length) {
        const endToken = chooseEndToken(document.text, tokens, startToken, this.policy);
        const first = tokens[startToken];
        const last = tokens[endToken - 1];
        if (!first || !last || endToken <= startToken) {
          throw new ChunkingError('Chunker failed to make forward progress');
        }
        const charStart = first.start;
        const charEnd = last.end;
        const text = document.text.slice(charStart, charEnd);
        const intersectingUnits = group.units.filter(
          (unit) => unit.locator.char_start < charEnd && unit.locator.char_end > charStart,
        );
        drafts.push(
          Object.freeze({
            chunkNo: drafts.length,
            chunkerVersion: CHUNKER_VERSION,
            metadata: Object.freeze({
              char_end: charEnd,
              char_start: charStart,
              headings: Object.freeze(commonHeadingPrefix(intersectingUnits)),
              ...(group.page === null ? {} : { page: group.page }),
              schema_version: 'chunk-metadata@1',
              ...(group.url === null ? {} : { url: group.url }),
            }),
            text,
            textHash: sha256(text),
            tokenCount: endToken - startToken,
          }),
        );
        if (endToken === tokens.length) break;
        startToken = endToken - this.policy.overlapTokens;
      }
    }
    if (drafts.length === 0) throw new ChunkingError('Material contains no chunkable tokens');
    return Object.freeze(drafts);
  }
}

export function countChunkTokens(text: string): number {
  return tokenize(text, 0).length;
}

function validatePolicy(policy: ChunkingPolicy): ChunkingPolicy {
  const values = [policy.minTokens, policy.targetTokens, policy.maxTokens, policy.overlapTokens];
  if (
    values.some((value) => !Number.isSafeInteger(value)) ||
    policy.minTokens < 1 ||
    policy.maxTokens > 900 ||
    policy.minTokens > policy.targetTokens ||
    policy.targetTokens > policy.maxTokens ||
    policy.overlapTokens < 0 ||
    policy.overlapTokens >= policy.minTokens
  ) {
    throw new TypeError('Chunking policy must satisfy overlap < min <= target <= max <= 900');
  }
  return Object.freeze({ ...policy });
}

function validateDocument(document: ChunkableMaterialDocument): void {
  if (!document.text || document.units.length === 0) {
    throw new ChunkingError('Parsed material is empty');
  }
  let previousEnd = 0;
  for (const unit of document.units) {
    const locator = unit.locator;
    if (
      !Number.isSafeInteger(locator.char_start) ||
      !Number.isSafeInteger(locator.char_end) ||
      locator.char_start < previousEnd ||
      locator.char_end <= locator.char_start ||
      locator.char_end > document.text.length ||
      document.text.slice(previousEnd, locator.char_start).trim() !== '' ||
      document.text.slice(locator.char_start, locator.char_end) !== unit.text ||
      sha256(unit.text) !== unit.text_hash
    ) {
      throw new ChunkingError('Parsed material unit provenance is invalid');
    }
    if (document.metadata.source_type === 'pdf' && locator.page === null) {
      throw new ChunkingError('PDF material unit is missing a page locator');
    }
    if (document.metadata.source_type === 'url' && locator.url === null) {
      throw new ChunkingError('URL material unit is missing a URL locator');
    }
    previousEnd = locator.char_end;
  }
  if (document.text.slice(previousEnd).trim() !== '') {
    throw new ChunkingError('Parsed material contains text without unit provenance');
  }
}

function locatorGroups(document: ChunkableMaterialDocument): readonly LocatorGroup[] {
  const groups: LocatorGroup[] = [];
  for (const unit of document.units) {
    const previous = groups.at(-1);
    if (previous && previous.page === unit.locator.page && previous.url === unit.locator.url) {
      groups[groups.length - 1] = {
        ...previous,
        end: unit.locator.char_end,
        units: Object.freeze([...previous.units, unit]),
      };
      continue;
    }
    groups.push({
      end: unit.locator.char_end,
      page: unit.locator.page,
      start: unit.locator.char_start,
      units: Object.freeze([unit]),
      url: unit.locator.url,
    });
  }
  return groups;
}

function tokenize(text: string, offset: number): TokenSpan[] {
  const tokens: TokenSpan[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = offset + (match.index ?? 0);
    tokens.push({ end: start + match[0].length, start });
  }
  return tokens;
}

function chooseEndToken(
  text: string,
  tokens: readonly TokenSpan[],
  startToken: number,
  policy: ChunkingPolicy,
): number {
  const remaining = tokens.length - startToken;
  if (remaining <= policy.maxTokens) return tokens.length;

  const minimumEnd = startToken + policy.minTokens;
  const maximumEnd = Math.min(tokens.length, startToken + policy.maxTokens);
  const targetEnd = Math.min(maximumEnd, startToken + policy.targetTokens);
  let endToken = nearestSemanticBoundary(text, tokens, minimumEnd, maximumEnd, targetEnd);

  const nextStart = endToken - policy.overlapTokens;
  if (tokens.length - nextStart < policy.minTokens) {
    const balancedEnd = tokens.length - policy.minTokens + policy.overlapTokens;
    if (balancedEnd >= minimumEnd && balancedEnd <= maximumEnd) endToken = balancedEnd;
    else endToken = minimumEnd;
  }
  return endToken;
}

function nearestSemanticBoundary(
  text: string,
  tokens: readonly TokenSpan[],
  minimumEnd: number,
  maximumEnd: number,
  targetEnd: number,
): number {
  let best = targetEnd;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let candidate = minimumEnd; candidate <= maximumEnd; candidate += 1) {
    const current = tokens[candidate - 1];
    const next = tokens[candidate];
    if (!current) continue;
    const tokenText = text.slice(current.start, current.end);
    const gap = next ? text.slice(current.end, next.start) : '';
    if (!/[。！？!?；;.]$/u.test(tokenText) && !/\n{2,}/u.test(gap)) continue;
    const distance = Math.abs(candidate - targetEnd);
    if (distance < bestDistance || (distance === bestDistance && candidate > best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function commonHeadingPrefix(units: ChunkableMaterialDocument['units']): string[] {
  const [first, ...rest] = units;
  if (!first) return [];
  const prefix = [...first.locator.headings];
  for (const unit of rest) {
    while (
      prefix.length > 0 &&
      !prefix.every((heading, index) => unit.locator.headings[index] === heading)
    ) {
      prefix.pop();
    }
  }
  return prefix;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
