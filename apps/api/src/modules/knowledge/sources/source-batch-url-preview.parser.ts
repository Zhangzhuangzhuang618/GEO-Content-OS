import ExcelJS, { type Cell, type Worksheet } from 'exceljs';
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import type { FastifyRequest } from 'fastify';

import { SourceUploadValidationError } from './source.errors.js';

const DEFAULT_URL_COLUMN = 'D';
const DEFAULT_START_ROW = 2;
const MAX_BATCH_ROWS = 500;
const MAX_COLUMN_NUMBER = 702;
const MAX_FILE_BYTES = 10 * 1_024 * 1_024;
const ALLOWED_FIELDS = new Set(['sheet_name', 'url_column', 'title_column', 'start_row']);

export type BatchUrlPreviewStatus = 'duplicate' | 'invalid' | 'ready';

export interface BatchUrlPreviewRow {
  readonly message: string | null;
  readonly row_number: number;
  readonly status: BatchUrlPreviewStatus;
  readonly title: string | null;
  readonly url: string;
}

export interface BatchUrlPreview {
  readonly duplicate_rows: number;
  readonly file_name: string;
  readonly invalid_rows: number;
  readonly ready_rows: number;
  readonly rows: readonly BatchUrlPreviewRow[];
  readonly sheet_name: string;
  readonly sheets: readonly string[];
  readonly start_row: number;
  readonly title_column: string | null;
  readonly total_rows: number;
  readonly url_column: string;
}

export interface ParsedBatchUpload {
  readonly body: Buffer;
  readonly filename: string;
  readonly sheetName: string | null;
  readonly startRow: number | null;
  readonly titleColumn: string | null;
  readonly urlColumn: string;
}

export async function parseBatchUrlPreview(request: FastifyRequest): Promise<BatchUrlPreview> {
  const upload = await parseBatchUpload(request);
  return previewBatchUrlFile(upload);
}

export async function previewBatchUrlFile(input: ParsedBatchUpload): Promise<BatchUrlPreview> {
  const workbook = new ExcelJS.Workbook();
  try {
    if (input.filename.toLowerCase().endsWith('.xlsx')) {
      validateXlsxSignature(input.body);
      await workbook.xlsx.load(input.body);
    } else if (input.filename.toLowerCase().endsWith('.csv')) {
      validateCsv(input.body);
      const rows = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(input.body));
      const worksheet = workbook.addWorksheet('CSV');
      for (const row of rows) worksheet.addRow(row);
    } else {
      throw new SourceUploadValidationError('Only XLSX and CSV batch files are supported');
    }
  } catch (error) {
    if (error instanceof SourceUploadValidationError) throw error;
    throw new SourceUploadValidationError('The spreadsheet could not be parsed');
  }

  const sheets = workbook.worksheets.map((worksheet) => worksheet.name);
  if (sheets.length === 0) throw new SourceUploadValidationError('The spreadsheet has no sheets');
  const sheetName = input.sheetName ?? chooseDefaultSheet(sheets);
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) throw new SourceUploadValidationError('The selected sheet does not exist');

  const urlColumnNumber = columnToNumber(input.urlColumn);
  const titleColumnNumber = input.titleColumn ? columnToNumber(input.titleColumn) : null;
  const startRow = input.startRow ?? detectStartRow(worksheet, urlColumnNumber);
  const rows = collectRows(worksheet, {
    startRow,
    titleColumnNumber,
    urlColumnNumber,
  });
  if (rows.length > MAX_BATCH_ROWS) {
    throw new SourceUploadValidationError(`A batch can contain at most ${MAX_BATCH_ROWS} URL rows`);
  }

  return Object.freeze({
    duplicate_rows: rows.filter((row) => row.status === 'duplicate').length,
    file_name: input.filename,
    invalid_rows: rows.filter((row) => row.status === 'invalid').length,
    ready_rows: rows.filter((row) => row.status === 'ready').length,
    rows: Object.freeze(rows),
    sheet_name: worksheet.name,
    sheets: Object.freeze(sheets),
    start_row: startRow,
    title_column: input.titleColumn,
    total_rows: rows.length,
    url_column: input.urlColumn,
  });
}

async function parseBatchUpload(request: FastifyRequest): Promise<ParsedBatchUpload> {
  if (!request.isMultipart()) {
    throw new SourceUploadValidationError('Content-Type must be multipart/form-data');
  }
  const fields = new Map<string, string>();
  let file: { body: Buffer; filename: string } | undefined;
  try {
    for await (const part of request.parts({
      limits: {
        fieldNameSize: 64,
        fieldSize: 512,
        fields: ALLOWED_FIELDS.size,
        fileSize: MAX_FILE_BYTES,
        files: 1,
        parts: ALLOWED_FIELDS.size + 1,
      },
    })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file' || file) {
          part.file.resume();
          throw new SourceUploadValidationError('Exactly one batch file is required');
        }
        const body = await part.toBuffer();
        if (part.file.truncated || body.byteLength === 0 || body.byteLength > MAX_FILE_BYTES) {
          throw new SourceUploadValidationError('Batch file is empty or exceeds 10 MiB');
        }
        file = { body, filename: normalizeFilename(part.filename) };
        continue;
      }
      if (!ALLOWED_FIELDS.has(part.fieldname) || fields.has(part.fieldname)) {
        throw new SourceUploadValidationError('Batch form contains an unknown or duplicate field');
      }
      if (part.valueTruncated || typeof part.value !== 'string') {
        throw new SourceUploadValidationError('Batch form fields must be strings');
      }
      fields.set(part.fieldname, part.value.trim());
    }
  } catch (error) {
    if (error instanceof SourceUploadValidationError) throw error;
    throw new SourceUploadValidationError('Batch upload exceeds the configured limits');
  }
  if (!file) throw new SourceUploadValidationError('A batch file is required');
  const startRow = parseStartRow(fields.get('start_row'));
  return Object.freeze({
    body: file.body,
    filename: file.filename,
    sheetName: optionalSafeText(fields.get('sheet_name'), 120),
    startRow,
    titleColumn: optionalColumn(fields.get('title_column')),
    urlColumn: parseColumn(fields.get('url_column') || DEFAULT_URL_COLUMN),
  });
}

function collectRows(
  worksheet: Worksheet,
  input: {
    readonly startRow: number;
    readonly titleColumnNumber: number | null;
    readonly urlColumnNumber: number;
  },
): BatchUrlPreviewRow[] {
  const rows: BatchUrlPreviewRow[] = [];
  const seen = new Set<string>();
  for (let rowNumber = input.startRow; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const rawUrl = readCell(row.getCell(input.urlColumnNumber)).trim();
    if (!rawUrl) continue;
    const rawTitle = input.titleColumnNumber
      ? readCell(row.getCell(input.titleColumnNumber)).trim()
      : '';
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) {
      rows.push({
        message: '不是有效的 HTTP(S) 地址',
        row_number: rowNumber,
        status: 'invalid',
        title: normalizeTitle(rawTitle),
        url: rawUrl.slice(0, 2_048),
      });
      continue;
    }
    if (seen.has(normalized)) {
      rows.push({
        message: '文件内重复，已跳过',
        row_number: rowNumber,
        status: 'duplicate',
        title: normalizeTitle(rawTitle),
        url: normalized,
      });
      continue;
    }
    seen.add(normalized);
    rows.push({
      message: null,
      row_number: rowNumber,
      status: 'ready',
      title: normalizeTitle(rawTitle),
      url: normalized,
    });
  }
  return rows;
}

function readCell(cell: Cell): string {
  if (cell.hyperlink) return cell.hyperlink;
  const value = cell.value;
  if (value && typeof value === 'object' && 'formula' in value) {
    const formulaUrl = extractHyperlinkFormula(String(value.formula));
    if (formulaUrl) return formulaUrl;
  }
  return cell.text;
}

function extractHyperlinkFormula(formula: string): string | null {
  const match = /^HYPERLINK\(\s*"((?:[^"]|"")+)"/iu.exec(formula);
  return match?.[1]?.replaceAll('""', '"') ?? null;
}

function normalizeUrl(raw: string): string | null {
  if (raw.length > 2_048 || hasControlCharacter(raw)) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeTitle(raw: string): string | null {
  const value = stripControlCharacters(raw).trim();
  if (!value) return null;
  return value.slice(0, 240);
}

function chooseDefaultSheet(sheets: readonly string[]): string {
  return sheets.includes('详细URL列表') ? '详细URL列表' : (sheets[0] as string);
}

function parseColumn(raw: string): string {
  const normalized = raw.trim().toUpperCase();
  const number = columnToNumber(normalized);
  if (number < 1 || number > MAX_COLUMN_NUMBER) {
    throw new SourceUploadValidationError('Column must be between A and ZZ');
  }
  return normalized;
}

function optionalColumn(raw: string | undefined): string | null {
  return raw ? parseColumn(raw) : null;
}

function columnToNumber(column: string): number {
  if (!/^[A-Z]{1,2}$/u.test(column)) {
    throw new SourceUploadValidationError('Column must be between A and ZZ');
  }
  let result = 0;
  for (const character of column) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function parseStartRow(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new SourceUploadValidationError('start_row must be an integer between 1 and 100000');
  }
  return value;
}

function detectStartRow(worksheet: Worksheet, urlColumnNumber: number): number {
  const headerLabels = new Set(['url', 'source_url', '网址', '网页地址', '链接']);
  const searchUntil = Math.min(worksheet.rowCount, 50);
  for (let rowNumber = 1; rowNumber <= searchUntil; rowNumber += 1) {
    const value = readCell(worksheet.getRow(rowNumber).getCell(urlColumnNumber))
      .trim()
      .toLowerCase();
    if (headerLabels.has(value)) return rowNumber + 1;
  }
  return DEFAULT_START_ROW;
}

function optionalSafeText(raw: string | undefined, maxLength: number): string | null {
  if (!raw) return null;
  if (raw.length > maxLength || hasControlCharacter(raw)) {
    throw new SourceUploadValidationError('Sheet name is invalid');
  }
  return raw;
}

function normalizeFilename(filename: string): string {
  const normalized = filename.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
  if (!normalized || normalized.length > 255 || hasControlCharacter(normalized)) {
    throw new SourceUploadValidationError('Batch filename is invalid');
  }
  return normalized;
}

function validateXlsxSignature(body: Buffer): void {
  if (
    !body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    !body.includes(Buffer.from('[Content_Types].xml')) ||
    !body.includes(Buffer.from('xl/'))
  ) {
    throw new SourceUploadValidationError('XLSX signature is invalid');
  }
}

function validateCsv(body: Buffer): void {
  if (body.includes(0)) throw new SourceUploadValidationError('CSV must be UTF-8 text');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new SourceUploadValidationError('CSV must be UTF-8 text');
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"' && field.length === 0) quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new SourceUploadValidationError('CSV contains an unclosed quote');
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join('');
}
