export type EmbeddingDriver = 'disabled' | 'mock';

export interface EmbeddingConfiguration {
  readonly driver: EmbeddingDriver;
  readonly maxBatchSize: number;
  readonly maxInputCharacters: number;
  readonly modelKey: string;
  readonly timeoutMs: number;
}

export function readEmbeddingConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingConfiguration {
  const driver = environment['EMBEDDING_DRIVER']?.trim() || 'disabled';
  if (driver !== 'disabled' && driver !== 'mock') {
    throw new Error('EMBEDDING_DRIVER must be disabled or mock');
  }
  if (driver === 'mock' && environment['NODE_ENV'] === 'production') {
    throw new Error('EMBEDDING_DRIVER=mock is forbidden in production');
  }
  return Object.freeze({
    driver,
    maxBatchSize: integer(environment['EMBEDDING_MAX_BATCH_SIZE'], 64, 1, 256),
    maxInputCharacters: integer(
      environment['EMBEDDING_MAX_INPUT_CHARACTERS'],
      1_000_000,
      1,
      5_000_000,
    ),
    modelKey: identifier(environment['EMBEDDING_MODEL_KEY'] || 'embedding-mock-v1', 'model key'),
    timeoutMs: integer(environment['EMBEDDING_TIMEOUT_MS'], 30_000, 100, 120_000),
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
    throw new Error(`Embedding limit must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function identifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(value)) {
    throw new Error(`Embedding ${name} is invalid`);
  }
  return value;
}
