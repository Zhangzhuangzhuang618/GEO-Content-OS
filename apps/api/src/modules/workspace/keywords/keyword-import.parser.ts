import type {
  KeywordImportJobView,
  KeywordSourceIntent,
  KeywordSuggestedPageType,
} from '@geo-content-os/contracts';
import ExcelJS, { type Cell, type Worksheet } from 'exceljs';
import JSZip from 'jszip';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import { KeywordValidationError } from './keyword.errors.js';

const MAX_FILE_BYTES = 25 * 1_024 * 1_024;
const MAX_ROWS = 100_000;
const MAX_NORMALIZED_XML_BYTES = 128 * 1_024 * 1_024;
const MAX_HEADER_ROW = 50;
const MAX_SYNONYMS = 50;
const ALLOWED_FIELDS = new Set(['sheet_name']);
const REQUIRED_HEADERS = new Set(['关键词', '搜索意图', '建议页面类型']);
const HEADER_NAMES = Object.freeze([
  '序号',
  '关键词',
  '地域',
  '服务类型',
  '搜索意图',
  '场景',
  '修饰词/路线',
  '建议页面类型',
  '生成来源',
] as const);

const INTENT_MAP = Object.freeze({
  价格咨询: ['informational', 'commercial'],
  信任筛选: ['commercial'],
  本地搜索: ['commercial', 'transactional'],
  品质筛选: ['commercial'],
  价格筛选: ['commercial'],
  联系方式: ['transactional'],
  '商圈/街道搜索': ['commercial', 'transactional'],
  即时需求: ['transactional'],
  路线需求: ['commercial', 'transactional'],
  时间需求: ['commercial', 'transactional'],
  比较选择: ['commercial'],
  预约转化: ['transactional'],
  服务方式: ['informational', 'commercial'],
  核心服务: ['commercial'],
  服务咨询: ['informational', 'commercial'],
  预约咨询: ['transactional'],
  避坑咨询: ['informational'],
  时效咨询: ['informational', 'commercial'],
  攻略咨询: ['informational'],
} as const satisfies Readonly<Record<KeywordSourceIntent, readonly KeywordIntent[]>>);

const PAGE_TYPES = new Set<KeywordSuggestedPageType>([
  '服务页',
  '报价页',
  '联系页',
  '对比页',
  '场景页',
  '企业服务页',
  '预约页',
  '问答页',
  '单项服务页',
  '车型页',
]);

type KeywordIntent = 'informational' | 'commercial' | 'transactional' | 'navigational';

export interface KeywordImportMetadataInput {
  readonly generation_source: string | null;
  readonly modifier_route: string | null;
  readonly region: string | null;
  readonly scene: string | null;
  readonly schema_version: 'keyword-import-metadata@1';
  readonly service_type: string | null;
  readonly source_intent: KeywordSourceIntent;
  readonly source_row: number;
  readonly source_sheet: string;
  readonly suggested_page_type: KeywordSuggestedPageType;
}

export interface KeywordImportCandidateInput {
  readonly clusterKey: string;
  readonly intents: readonly KeywordIntent[];
  readonly metadata: KeywordImportMetadataInput;
  readonly rowNumber: number;
  readonly sourceIntent: KeywordSourceIntent;
  readonly suggestedPageType: KeywordSuggestedPageType;
  readonly synonyms: readonly string[];
  readonly term: string;
}

export interface ParsedKeywordImportPreflight {
  readonly candidates: readonly KeywordImportCandidateInput[];
  readonly contentHash: string;
  readonly fileName: string;
  readonly foldedRowCount: number;
  readonly headerRow: number;
  readonly invalidRowCount: number;
  readonly sheetName: string;
  readonly summary: KeywordImportJobView['summary'];
  readonly totalRowCount: number;
}

export async function parseKeywordImportPreflight(
  request: FastifyRequest,
): Promise<ParsedKeywordImportPreflight> {
  if (!request.isMultipart()) {
    throw new KeywordValidationError('Content-Type must be multipart/form-data');
  }
  const fields = new Map<string, string>();
  let file: { readonly body: Buffer; readonly filename: string } | undefined;
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
          throw new KeywordValidationError('Exactly one XLSX file is required');
        }
        const body = await part.toBuffer();
        if (part.file.truncated || body.byteLength === 0 || body.byteLength > MAX_FILE_BYTES) {
          throw new KeywordValidationError('XLSX file is empty or exceeds 25 MiB');
        }
        file = { body, filename: normalizeFilename(part.filename) };
        continue;
      }
      if (!ALLOWED_FIELDS.has(part.fieldname) || fields.has(part.fieldname)) {
        throw new KeywordValidationError('Import form contains an unknown or duplicate field');
      }
      if (part.valueTruncated || typeof part.value !== 'string') {
        throw new KeywordValidationError('Import form fields must be strings');
      }
      fields.set(part.fieldname, part.value.trim());
    }
  } catch (error) {
    if (error instanceof KeywordValidationError) throw error;
    throw new KeywordValidationError('Keyword spreadsheet exceeds upload limits');
  }
  if (!file) throw new KeywordValidationError('An XLSX file is required');
  return previewKeywordWorkbook({
    body: file.body,
    fileName: file.filename,
    sheetName: optionalSafeText(fields.get('sheet_name')),
  });
}

export async function previewKeywordWorkbook(input: {
  readonly body: Buffer;
  readonly fileName: string;
  readonly sheetName: string | null;
}): Promise<ParsedKeywordImportPreflight> {
  if (!input.fileName.toLowerCase().endsWith('.xlsx')) {
    throw new KeywordValidationError('Only XLSX keyword files are supported');
  }
  validateXlsxSignature(input.body);
  const workbook = await loadWorkbook(input.body);
  const worksheet = input.sheetName
    ? workbook.getWorksheet(input.sheetName)
    : (workbook.getWorksheet('关键词库') ?? workbook.worksheets[0]);
  if (!worksheet) throw new KeywordValidationError('Keyword spreadsheet has no worksheet');
  const header = detectHeader(worksheet);
  const clusters = new Map<string, MutableCandidate>();
  const seenTerms = new Set<string>();
  let totalRowCount = 0;
  let invalidRowCount = 0;
  let foldedRowCount = 0;

  for (let rowNumber = header.rowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const raw = readRow(worksheet, rowNumber, header.columns);
    if (Object.values(raw).every((value) => value.length === 0)) continue;
    totalRowCount += 1;
    if (totalRowCount > MAX_ROWS) {
      throw new KeywordValidationError(`Keyword spreadsheet exceeds ${MAX_ROWS} data rows`);
    }
    const term = normalizeCell(raw['关键词'], 240);
    const sourceIntent = raw['搜索意图'] as KeywordSourceIntent;
    const suggestedPageType = raw['建议页面类型'] as KeywordSuggestedPageType;
    if (!term || !(sourceIntent in INTENT_MAP) || !PAGE_TYPES.has(suggestedPageType)) {
      invalidRowCount += 1;
      continue;
    }
    const normalizedTerm = term.toLocaleLowerCase('zh-CN');
    if (seenTerms.has(normalizedTerm)) {
      foldedRowCount += 1;
      continue;
    }
    seenTerms.add(normalizedTerm);
    const metadata: KeywordImportMetadataInput = {
      generation_source: nullableCell(raw['生成来源']),
      modifier_route: nullableCell(raw['修饰词/路线']),
      region: nullableCell(raw['地域']),
      scene: nullableCell(raw['场景']),
      schema_version: 'keyword-import-metadata@1',
      service_type: nullableCell(raw['服务类型']),
      source_intent: sourceIntent,
      source_row: rowNumber,
      source_sheet: worksheet.name,
      suggested_page_type: suggestedPageType,
    };
    const baseClusterKey = clusterKey(metadata, term);
    const existing = clusters.get(baseClusterKey);
    if (existing) {
      if (existing.synonyms.length >= MAX_SYNONYMS) {
        invalidRowCount += 1;
        continue;
      }
      existing.synonyms.push(term);
      foldedRowCount += 1;
      continue;
    }
    clusters.set(baseClusterKey, {
      clusterKey: baseClusterKey,
      intents: INTENT_MAP[sourceIntent],
      metadata,
      rowNumber,
      sourceIntent,
      suggestedPageType,
      synonyms: [],
      term,
    });
  }
  if (clusters.size === 0) {
    throw new KeywordValidationError('Keyword spreadsheet has no valid import candidates');
  }
  const candidates = [...clusters.values()].map((candidate) =>
    Object.freeze({ ...candidate, synonyms: Object.freeze([...candidate.synonyms]) }),
  );
  const summary = {
    candidate_samples: candidates.slice(0, 20).map((candidate) => ({
      intents: [...candidate.intents],
      source_intent: candidate.sourceIntent,
      suggested_page_type: candidate.suggestedPageType,
      synonyms: [...candidate.synonyms],
      term: candidate.term,
    })),
    page_types: countLabels(candidates.map((item) => item.suggestedPageType)),
    source_intents: countLabels(candidates.map((item) => item.sourceIntent)),
  };
  return Object.freeze({
    candidates: Object.freeze(candidates),
    contentHash: createHash('sha256').update(input.body).digest('hex'),
    fileName: normalizeFilename(input.fileName),
    foldedRowCount,
    headerRow: header.rowNumber,
    invalidRowCount,
    sheetName: worksheet.name,
    summary,
    totalRowCount,
  });
}

async function loadWorkbook(body: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(body);
    return workbook;
  } catch {
    // Some valid XLSX writers prefix SpreadsheetML elements with `x:`. ExcelJS 4.4
    // does not accept those prefixes, so normalize that representation and retry.
  }
  try {
    const zip = await JSZip.loadAsync(body);
    let normalizedBytes = 0;
    let normalizedFiles = 0;
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir || !path.endsWith('.xml')) continue;
      const xml = await entry.async('string');
      normalizedBytes += Buffer.byteLength(xml);
      if (normalizedBytes > MAX_NORMALIZED_XML_BYTES) {
        throw new Error('Spreadsheet XML exceeds normalization limit');
      }
      if (!xml.includes('xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')) {
        continue;
      }
      zip.file(
        path,
        xml.replaceAll('<x:', '<').replaceAll('</x:', '</').replaceAll('xmlns:x=', 'xmlns='),
      );
      normalizedFiles += 1;
    }
    if (normalizedFiles === 0) throw new Error('No prefixed SpreadsheetML XML found');
    const normalizedBody = await zip.generateAsync({ type: 'nodebuffer' });
    const normalizedWorkbook = new ExcelJS.Workbook();
    await normalizedWorkbook.xlsx.load(normalizedBody);
    return normalizedWorkbook;
  } catch {
    throw new KeywordValidationError('Keyword spreadsheet could not be parsed');
  }
}

interface MutableCandidate extends KeywordImportCandidateInput {
  readonly synonyms: string[];
}

function detectHeader(worksheet: Worksheet): {
  readonly columns: ReadonlyMap<(typeof HEADER_NAMES)[number], number>;
  readonly rowNumber: number;
} {
  const searchUntil = Math.min(worksheet.rowCount, MAX_HEADER_ROW);
  for (let rowNumber = 1; rowNumber <= searchUntil; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const columns = new Map<(typeof HEADER_NAMES)[number], number>();
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const value = normalizeHeader(readCell(cell));
      const header = HEADER_NAMES.find((candidate) => normalizeHeader(candidate) === value);
      if (header && !columns.has(header)) columns.set(header, columnNumber);
    });
    if ([...REQUIRED_HEADERS].every((header) => columns.has(header as never))) {
      return { columns, rowNumber };
    }
  }
  throw new KeywordValidationError('Could not find keyword, search intent, and page type headers');
}

function readRow(
  worksheet: Worksheet,
  rowNumber: number,
  columns: ReadonlyMap<(typeof HEADER_NAMES)[number], number>,
): Record<(typeof HEADER_NAMES)[number], string> {
  const row = worksheet.getRow(rowNumber);
  return Object.fromEntries(
    HEADER_NAMES.map((header) => {
      const column = columns.get(header);
      return [header, column ? normalizeCell(readCell(row.getCell(column)), 240) : ''];
    }),
  ) as Record<(typeof HEADER_NAMES)[number], string>;
}

function clusterKey(metadata: KeywordImportMetadataInput, term: string): string {
  const dimensions = [
    metadata.region,
    metadata.service_type,
    metadata.source_intent,
    metadata.scene,
    metadata.modifier_route,
    metadata.suggested_page_type,
    metadata.generation_source,
  ];
  const populated = dimensions.filter(Boolean).length;
  const identity = populated >= 3 ? dimensions : [...dimensions, term.toLocaleLowerCase('zh-CN')];
  return createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex');
}

function countLabels(
  values: readonly string[],
): { readonly count: number; readonly label: string }[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, count]) => ({ count, label }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function readCell(cell: Cell): string {
  return cell.text;
}

function normalizeHeader(value: string): string {
  return value.replaceAll(/\s+/gu, '').trim();
}

function normalizeCell(value: string, maxLength: number): string {
  const normalized = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .trim();
  return normalized.length <= maxLength ? normalized : '';
}

function nullableCell(value: string): string | null {
  return value || null;
}

function optionalSafeText(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeCell(value, 120);
  if (!normalized) throw new KeywordValidationError('Sheet name is invalid');
  return normalized;
}

function normalizeFilename(value: string): string {
  const filename = value.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
  const normalized = normalizeCell(filename, 255);
  if (!normalized) throw new KeywordValidationError('Filename is invalid');
  return normalized;
}

function validateXlsxSignature(body: Buffer): void {
  if (
    !body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    !body.includes(Buffer.from('[Content_Types].xml')) ||
    !body.includes(Buffer.from('xl/'))
  ) {
    throw new KeywordValidationError('XLSX signature is invalid');
  }
}
