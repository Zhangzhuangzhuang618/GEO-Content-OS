export type RerankDriver = 'disabled' | 'mock';

export interface RerankConfiguration {
  readonly driver: RerankDriver;
  readonly maxDocuments: number;
  readonly maxInputCharacters: number;
  readonly modelKey: string;
  readonly timeoutMs: number;
}

export function readRerankConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): RerankConfiguration {
  const driver = environment['RERANK_DRIVER']?.trim() || 'disabled';
  if (driver !== 'disabled' && driver !== 'mock') {
    throw new Error('RERANK_DRIVER must be disabled or mock');
  }
  if (driver === 'mock' && environment['NODE_ENV'] === 'production') {
    throw new Error('RERANK_DRIVER=mock is forbidden in production');
  }
  return Object.freeze({
    driver,
    maxDocuments: integer(environment['RERANK_MAX_DOCUMENTS'], 20, 1, 100),
    maxInputCharacters: integer(environment['RERANK_MAX_INPUT_CHARACTERS'], 200_000, 1, 1_000_000),
    modelKey: identifier(environment['RERANK_MODEL_KEY'] || 'rerank-mock-v1'),
    timeoutMs: integer(environment['RERANK_TIMEOUT_MS'], 10_000, 100, 120_000),
  });
}

function integer(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Rerank limit must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(value)) {
    throw new Error('Rerank model key is invalid');
  }
  return value;
}
