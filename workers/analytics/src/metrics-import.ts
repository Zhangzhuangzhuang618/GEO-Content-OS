export const METRIC_CSV_HEADERS = Object.freeze([
  'platform_code',
  'account_id',
  'variant_id',
  'metric_date',
  'metric_name',
  'metric_value',
] as const);

export interface MetricImportRow {
  readonly accountId: string | null;
  readonly metricDate: string;
  readonly metricName: string;
  readonly metricValue: number;
  readonly platformCode: string;
  readonly variantId: string | null;
}

export interface MetricImportRowError {
  readonly code: 'COLUMN_COUNT' | 'HEADER_INVALID' | 'ROW_INVALID';
  readonly line: number;
  readonly message: string;
}

export interface MetricImportPreview {
  readonly errors: readonly MetricImportRowError[];
  readonly rows: readonly MetricImportRow[];
  readonly totalRows: number;
}

const PLATFORM_CODES = new Set([
  'official_site',
  'baijiahao',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function previewMetricsCsv(csv: string): MetricImportPreview {
  const records = parseCsv(csv);
  if (records.length === 0) return Object.freeze({ errors: [], rows: [], totalRows: 0 });
  const header = records[0]!;
  if (
    header.length !== METRIC_CSV_HEADERS.length ||
    header.some((value, index) => value.trim() !== METRIC_CSV_HEADERS[index])
  ) {
    return Object.freeze({
      errors: Object.freeze<MetricImportRowError[]>([
        { code: 'HEADER_INVALID', line: 1, message: 'CSV header is invalid' },
      ]),
      rows: [],
      totalRows: Math.max(0, records.length - 1),
    });
  }

  const rows: MetricImportRow[] = [];
  const errors: MetricImportRowError[] = [];
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index]!;
    const line = index + 1;
    if (record.length !== METRIC_CSV_HEADERS.length) {
      errors.push({ code: 'COLUMN_COUNT', line, message: 'CSV row has the wrong column count' });
      continue;
    }
    try {
      rows.push(
        normalizeMetricImportRow({
          accountId: nullable(record[1]!),
          metricDate: record[3]!,
          metricName: record[4]!,
          metricValue: Number(record[5]),
          platformCode: record[0]!,
          variantId: nullable(record[2]!),
        }),
      );
    } catch {
      errors.push({ code: 'ROW_INVALID', line, message: 'CSV row is invalid' });
    }
  }
  return Object.freeze({
    errors: Object.freeze(errors),
    rows: Object.freeze(rows),
    totalRows: records.length - 1,
  });
}

export function normalizeMetricImportRow(row: MetricImportRow): MetricImportRow {
  const metricDate = row.metricDate.trim();
  const metricName = row.metricName.trim();
  const accountId = row.accountId?.trim() || null;
  const variantId = row.variantId?.trim() || null;
  if (
    !PLATFORM_CODES.has(row.platformCode) ||
    !validDate(metricDate) ||
    !/^[a-z][a-z0-9_]{0,63}$/u.test(metricName) ||
    !Number.isFinite(row.metricValue) ||
    (accountId !== null && !UUID.test(accountId)) ||
    (variantId !== null && !UUID.test(variantId))
  ) {
    throw new TypeError('Metric import row is invalid');
  }
  return Object.freeze({
    accountId,
    metricDate,
    metricName,
    metricValue: row.metricValue,
    platformCode: row.platformCode,
    variantId,
  });
}

function parseCsv(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]!;
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\n') {
      record.push(field.replace(/\r$/u, ''));
      if (record.some((value) => value.length > 0)) records.push(record);
      record = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new TypeError('CSV contains an unterminated quoted field');
  record.push(field.replace(/\r$/u, ''));
  if (record.some((value) => value.length > 0)) records.push(record);
  return records;
}

function nullable(value: string): string | null {
  return value.trim() || null;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
