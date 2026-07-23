import mammoth from 'mammoth';
import { TextDecoder } from 'node:util';
import {
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';

import { extractHtmlUnits } from './html.extractor.js';
import { validateDocxArchive } from './docx.preflight.js';
import { MaterialParserError } from './parser.errors.js';
import { finalizeDocument, normalizeText, sha256, type ExtractedUnit } from './normalization.js';
import type { ParsedMaterialDocument, ParseMaterialInput, ParserWarning } from './parser.types.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DEFAULT_MAX_INPUT_BYTES = 25 * 1_024 * 1_024;
const DEFAULT_MAX_CHARACTERS = 5_000_000;
const DEFAULT_MAX_DOCX_EXPANDED_BYTES = 100 * 1_024 * 1_024;
const DEFAULT_MAX_PAGES = 1_000;

export interface MaterialParserOptions {
  readonly maxCharacters?: number;
  readonly maxDocxExpandedBytes?: number;
  readonly maxInputBytes?: number;
  readonly maxPages?: number;
}

export class MaterialParser {
  private readonly maxCharacters: number;
  private readonly maxDocxExpandedBytes: number;
  private readonly maxInputBytes: number;
  private readonly maxPages: number;

  public constructor(options: MaterialParserOptions = {}) {
    this.maxCharacters = boundedInteger(
      options.maxCharacters,
      DEFAULT_MAX_CHARACTERS,
      1,
      20_000_000,
      'maxCharacters',
    );
    this.maxDocxExpandedBytes = boundedInteger(
      options.maxDocxExpandedBytes,
      DEFAULT_MAX_DOCX_EXPANDED_BYTES,
      1,
      500 * 1_024 * 1_024,
      'maxDocxExpandedBytes',
    );
    this.maxInputBytes = boundedInteger(
      options.maxInputBytes,
      DEFAULT_MAX_INPUT_BYTES,
      1,
      100 * 1_024 * 1_024,
      'maxInputBytes',
    );
    this.maxPages = boundedInteger(options.maxPages, DEFAULT_MAX_PAGES, 1, 5_000, 'maxPages');
  }

  public async parse(input: ParseMaterialInput): Promise<ParsedMaterialDocument> {
    validateInput(input, this.maxInputBytes);
    const mimeType = input.mimeType.split(';', 1)[0]?.trim().toLowerCase();
    if (input.sourceType === 'image') {
      throw new MaterialParserError(
        'UNSUPPORTED_MIME',
        'Image sources require the OCR Adapter before material parsing',
      );
    }
    if (input.sourceType === 'pdf' && mimeType === 'application/pdf') {
      return this.parsePdf(input);
    }
    if (input.sourceType === 'docx' && mimeType === DOCX_MIME) {
      return this.parseDocx(input);
    }
    if (input.sourceType === 'txt' && mimeType === 'text/plain') {
      return this.parseText(input);
    }
    if (
      input.sourceType === 'url' &&
      (mimeType === 'text/html' || mimeType === 'application/xhtml+xml')
    ) {
      return this.parseHtml(input);
    }
    if (input.sourceType === 'url' && mimeType === 'text/plain') {
      return this.parseUrlText(input);
    }
    throw new MaterialParserError(
      'UNSUPPORTED_MIME',
      'Source type and MIME do not match a supported material parser',
    );
  }

  private parseText(input: ParseMaterialInput): ParsedMaterialDocument {
    const text = decodeUtf8(input.body);
    return finalizeDocument({
      contentHash: input.contentHash,
      language: input.language,
      maxCharacters: this.maxCharacters,
      pageCount: null,
      sourceType: 'txt',
      title: input.title,
      units: splitTextUnits(text).map((unit) => ({ text: unit })),
    });
  }

  private parseHtml(input: ParseMaterialInput): ParsedMaterialDocument {
    const url = normalizeSourceUrl(input.url);
    const extraction = extractHtmlUnits(decodeUtf8(input.body), url);
    const warnings: ParserWarning[] = extraction.usedMainContent
      ? []
      : [
          {
            code: 'HTML_NO_MAIN_CONTENT',
            message: 'No main/article element was found; body content was used',
            page: null,
          },
        ];
    return finalizeDocument({
      contentHash: input.contentHash,
      language: input.language,
      maxCharacters: this.maxCharacters,
      pageCount: null,
      sourceType: 'url',
      title: input.title,
      units: extraction.units,
      warnings,
    });
  }

  private parseUrlText(input: ParseMaterialInput): ParsedMaterialDocument {
    const url = normalizeSourceUrl(input.url);
    return finalizeDocument({
      contentHash: input.contentHash,
      language: input.language,
      maxCharacters: this.maxCharacters,
      pageCount: null,
      sourceType: 'url',
      title: input.title,
      units: splitTextUnits(decodeUtf8(input.body)).map((text) => ({ text, url })),
    });
  }

  private async parseDocx(input: ParseMaterialInput): Promise<ParsedMaterialDocument> {
    validateDocxArchive(input.body, this.maxDocxExpandedBytes);
    let converted: Awaited<ReturnType<typeof mammoth.convertToHtml>>;
    try {
      converted = await mammoth.convertToHtml(
        { buffer: Buffer.from(input.body) },
        {
          convertImage: mammoth.images.imgElement(async () => ({ src: 'about:blank' })),
          externalFileAccess: false,
          includeDefaultStyleMap: true,
          includeEmbeddedStyleMap: false,
        },
      );
    } catch (error) {
      throw new MaterialParserError('PARSE_EMPTY', 'DOCX parsing failed', { cause: error });
    }
    const extraction = extractHtmlUnits(converted.value, null);
    const warnings: ParserWarning[] = converted.messages.slice(0, 100).map((message) => ({
      code: 'DOCX_CONVERSION_WARNING',
      message: normalizeWarning(message.message),
      page: null,
    }));
    return finalizeDocument({
      contentHash: input.contentHash,
      language: input.language,
      maxCharacters: this.maxCharacters,
      pageCount: null,
      sourceType: 'docx',
      title: input.title,
      units: extraction.units,
      warnings,
    });
  }

  private async parsePdf(input: ParseMaterialInput): Promise<ParsedMaterialDocument> {
    let document: PDFDocumentProxy | undefined;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    try {
      loadingTask = getDocument({
        data: Uint8Array.from(input.body),
        disableFontFace: true,
        stopAtErrors: true,
        useSystemFonts: false,
        useWasm: false,
      });
      document = await loadingTask.promise;
      if (document.numPages > this.maxPages) {
        throw new MaterialParserError('PARSE_EMPTY', 'PDF exceeds the configured page limit');
      }
      const units: ExtractedUnit[] = [];
      const warnings: ParserWarning[] = [];
      let extractedCharacters = 0;
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent({ disableNormalization: false });
        const text = pdfText(content.items);
        if (text) {
          extractedCharacters += text.length + (units.length > 0 ? 2 : 0);
          if (extractedCharacters > this.maxCharacters) {
            throw new MaterialParserError(
              'PARSE_EMPTY',
              'Parsed material exceeds the character limit',
            );
          }
          units.push({ page: pageNumber, text });
        } else {
          warnings.push({
            code: 'EMPTY_PAGE',
            message: 'PDF page contains no extractable text and may require OCR',
            page: pageNumber,
          });
        }
        page.cleanup();
      }
      return finalizeDocument({
        contentHash: input.contentHash,
        language: input.language,
        maxCharacters: this.maxCharacters,
        pageCount: document.numPages,
        sourceType: 'pdf',
        title: input.title,
        units,
        warnings,
      });
    } catch (error) {
      if (error instanceof MaterialParserError) throw error;
      throw new MaterialParserError('PARSE_EMPTY', 'PDF parsing failed', { cause: error });
    } finally {
      await document?.cleanup();
      await loadingTask?.destroy();
    }
  }
}

function validateInput(input: ParseMaterialInput, maxInputBytes: number): void {
  if (input.body.byteLength === 0 || input.body.byteLength > maxInputBytes) {
    throw new MaterialParserError('PARSE_EMPTY', 'Source body is empty or exceeds the input limit');
  }
  if (!/^[a-f0-9]{64}$/u.test(input.contentHash)) {
    throw new TypeError('contentHash must be a lowercase SHA-256 value');
  }
  if (sha256(input.body) !== input.contentHash) {
    throw new TypeError('contentHash does not match the material body');
  }
  if (!input.title.trim() || !input.language.trim()) {
    throw new TypeError('title and language are required');
  }
}

function decodeUtf8(body: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error) {
    throw new MaterialParserError('PARSE_EMPTY', 'Text source is not valid UTF-8', {
      cause: error,
    });
  }
}

function splitTextUnits(text: string): string[] {
  return normalizeText(text)
    .split(/\n{2,}/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeSourceUrl(raw: string | undefined): string {
  if (!raw) throw new MaterialParserError('LOCATOR_MISSING', 'HTML source URL is required');
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error();
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
    return url.toString();
  } catch {
    throw new MaterialParserError('LOCATOR_MISSING', 'HTML source URL is invalid');
  }
}

function pdfText(items: readonly unknown[]): string {
  let value = '';
  for (const item of items) {
    if (!isPdfTextItem(item)) continue;
    const next = item.str;
    if (needsAsciiWordSpace(value, next)) value += ' ';
    value += next;
    if (item.hasEOL) value += '\n';
  }
  return normalizeText(value);
}

function isPdfTextItem(
  value: unknown,
): value is { readonly hasEOL: boolean; readonly str: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'str' in value &&
    typeof value.str === 'string' &&
    'hasEOL' in value &&
    typeof value.hasEOL === 'boolean'
  );
}

function needsAsciiWordSpace(current: string, next: string): boolean {
  return /[A-Za-z0-9]$/u.test(current) && /^[A-Za-z0-9]/u.test(next);
}

function normalizeWarning(value: string): string {
  return normalizeText(value).slice(0, 500) || 'DOCX conversion warning';
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return normalized;
}
