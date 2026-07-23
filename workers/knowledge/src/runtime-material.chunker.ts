import { createHash } from 'node:crypto';

import type { ParsedMaterialDocument } from '@geo-content-os/parsers';

import type { MaterialChunkerPort, SourceChunkDraft } from './ingest.types.js';

const TOKEN_PATTERN = /[\p{Script=Han}]|[\p{L}\p{M}\p{N}]+(?:['’._-][\p{L}\p{M}\p{N}]+)*|[^\s]/gu;
const TARGET_TOKENS = 700;
const MAX_TOKENS = 900;
const OVERLAP_TOKENS = 80;

interface TokenSpan {
  readonly end: number;
  readonly start: number;
}

export class RuntimeMaterialChunker implements MaterialChunkerPort {
  public chunk(document: ParsedMaterialDocument): readonly SourceChunkDraft[] {
    const tokens = tokenize(document.text);
    if (tokens.length === 0) throw new Error('Material contains no chunkable text');
    const chunks: SourceChunkDraft[] = [];
    let start = 0;
    while (start < tokens.length) {
      const end = Math.min(tokens.length, chooseEnd(document.text, tokens, start));
      const first = tokens[start];
      const last = tokens[end - 1];
      if (!first || !last || end <= start) throw new Error('Chunker failed to make progress');
      const text = document.text.slice(first.start, last.end);
      const units = document.units.filter(
        (unit) => unit.locator.char_start < last.end && unit.locator.char_end > first.start,
      );
      const pages = new Set(
        units.map((unit) => unit.locator.page).filter((value) => value !== null),
      );
      const urls = new Set(units.map((unit) => unit.locator.url).filter((value) => value !== null));
      chunks.push({
        chunkNo: chunks.length,
        metadata: {
          char_end: last.end,
          char_start: first.start,
          headings: commonHeadings(units),
          ...(pages.size === 1 ? { page: [...pages][0] } : {}),
          schema_version: 'chunk-metadata@1',
          ...(urls.size === 1 ? { url: [...urls][0] } : {}),
        },
        text,
        textHash: createHash('sha256').update(text).digest('hex'),
        tokenCount: end - start,
      });
      if (end === tokens.length) break;
      start = Math.max(start + 1, end - OVERLAP_TOKENS);
    }
    return Object.freeze(chunks);
  }
}

function tokenize(text: string): TokenSpan[] {
  return [...text.matchAll(TOKEN_PATTERN)].map((match) => ({
    end: (match.index ?? 0) + match[0].length,
    start: match.index ?? 0,
  }));
}

function chooseEnd(text: string, tokens: readonly TokenSpan[], start: number): number {
  const maximum = Math.min(tokens.length, start + MAX_TOKENS);
  const target = Math.min(maximum, start + TARGET_TOKENS);
  if (maximum === tokens.length) return maximum;
  for (let distance = 0; distance <= MAX_TOKENS - TARGET_TOKENS; distance += 1) {
    for (const candidate of [target + distance, target - distance]) {
      if (candidate <= start || candidate > maximum) continue;
      const token = tokens[candidate - 1];
      if (token && /[。！？!?；;.]$/u.test(text.slice(token.start, token.end))) return candidate;
    }
  }
  return target;
}

function commonHeadings(units: ParsedMaterialDocument['units']): readonly string[] {
  const first = units[0];
  if (!first) return Object.freeze([]);
  const headings = [...first.locator.headings];
  for (const unit of units.slice(1)) {
    while (headings.some((heading, index) => unit.locator.headings[index] !== heading)) {
      headings.pop();
    }
  }
  return Object.freeze(headings);
}
