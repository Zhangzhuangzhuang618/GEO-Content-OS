import { createHash } from 'node:crypto';

import { MaterialParserError } from './parser.errors.js';
import {
  MATERIAL_PARSER_VERSION,
  type MaterialSourceType,
  type ParsedMaterialDocument,
  type ParserWarning,
} from './parser.types.js';

export interface ExtractedUnit {
  readonly headings?: readonly string[];
  readonly page?: number | null;
  readonly text: string;
  readonly url?: string | null;
}

export interface FinalizeDocumentInput {
  readonly contentHash: string;
  readonly language: string;
  readonly maxCharacters: number;
  readonly pageCount: number | null;
  readonly sourceType: Exclude<MaterialSourceType, 'image'>;
  readonly title: string;
  readonly units: readonly ExtractedUnit[];
  readonly warnings?: readonly ParserWarning[];
}

export function finalizeDocument(input: FinalizeDocumentInput): ParsedMaterialDocument {
  const normalizedUnits = input.units
    .map((unit) => ({
      headings: normalizeHeadings(unit.headings ?? []),
      page: unit.page ?? null,
      text: normalizeText(unit.text),
      url: unit.url ?? null,
    }))
    .filter((unit) => unit.text.length > 0);
  if (normalizedUnits.length === 0) {
    throw new MaterialParserError('PARSE_EMPTY', 'Material parser extracted no usable text');
  }
  if (input.sourceType === 'pdf' && normalizedUnits.some((unit) => unit.page === null)) {
    throw new MaterialParserError('LOCATOR_MISSING', 'PDF text unit is missing its page locator');
  }
  if (input.sourceType === 'url' && normalizedUnits.some((unit) => unit.url === null)) {
    throw new MaterialParserError('LOCATOR_MISSING', 'URL text unit is missing its URL locator');
  }

  let text = '';
  const units = normalizedUnits.map((unit) => {
    if (text) text += '\n\n';
    const charStart = text.length;
    text += unit.text;
    if (text.length > input.maxCharacters) {
      throw new MaterialParserError('PARSE_EMPTY', 'Parsed material exceeds the character limit');
    }
    return Object.freeze({
      locator: Object.freeze({
        char_end: text.length,
        char_start: charStart,
        headings: Object.freeze([...unit.headings]),
        page: unit.page,
        url: unit.url,
      }),
      text: unit.text,
      text_hash: sha256(unit.text),
    });
  });

  return Object.freeze({
    content_hash: input.contentHash,
    language: input.language,
    metadata: Object.freeze({ page_count: input.pageCount, source_type: input.sourceType }),
    parser_version: MATERIAL_PARSER_VERSION,
    text,
    title: normalizeRequiredText(input.title, 'title'),
    units: Object.freeze(units),
    warnings: Object.freeze([...(input.warnings ?? [])]),
  });
}

export function normalizeText(value: string): string {
  return stripUnsafeControls(value)
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\u00A0\u2000-\u200A\u202F\u205F\u3000]+/gu, ' ')
    .split('\n')
    .map((line) => line.replace(/ {2,}/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function stripUnsafeControls(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('');
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeHeadings(headings: readonly string[]): readonly string[] {
  return Object.freeze(headings.map(normalizeText).filter(Boolean).slice(0, 6));
}

function normalizeRequiredText(value: string, name: string): string {
  const normalized = normalizeText(value);
  if (!normalized) throw new MaterialParserError('PARSE_EMPTY', `${name} must not be empty`);
  return normalized;
}
