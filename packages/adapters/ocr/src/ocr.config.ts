const MEBIBYTE = 1_024 * 1_024;

export type OcrDriver = 'disabled' | 'mock';

export interface OcrConfiguration {
  readonly driver: OcrDriver;
  readonly maxBytes: number;
  readonly maxCharacters: number;
  readonly maxPages: number;
  readonly timeoutMs: number;
}

export function readOcrConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): OcrConfiguration {
  const driver = parseDriver(environment['OCR_DRIVER']);
  if (environment['NODE_ENV'] === 'production' && driver === 'mock') {
    throw new Error('OCR_DRIVER=mock is forbidden in production');
  }
  return Object.freeze({
    driver,
    maxBytes: parseInteger(environment['OCR_MAX_BYTES'], 25 * MEBIBYTE, 1, 25 * MEBIBYTE),
    maxCharacters: parseInteger(environment['OCR_MAX_CHARACTERS'], 1_000_000, 1, 5_000_000),
    maxPages: parseInteger(environment['OCR_MAX_PAGES'], 20, 1, 100),
    timeoutMs: parseInteger(environment['OCR_TIMEOUT_MS'], 15_000, 100, 60_000),
  });
}

function parseDriver(raw: string | undefined): OcrDriver {
  const value = raw?.trim() || 'disabled';
  if (value === 'disabled' || value === 'mock') return value;
  throw new Error('OCR_DRIVER must be disabled or mock');
}

function parseInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`OCR limit must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
