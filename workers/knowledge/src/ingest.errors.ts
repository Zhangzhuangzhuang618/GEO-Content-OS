export class IngestWorkerError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    options: { readonly cause?: unknown; readonly retryable: boolean },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'IngestWorkerError';
    this.code = code;
    this.retryable = options.retryable;
  }
}

export function asIngestError(error: unknown): IngestWorkerError {
  if (error instanceof IngestWorkerError) return error;
  if (hasAdapterErrorShape(error)) {
    return new IngestWorkerError(error.code, 'Knowledge ingestion adapter failed', {
      cause: error,
      retryable: error.retryable,
    });
  }
  if (
    error instanceof Error &&
    (error.name === 'MaterialParserError' || error.name === 'ChunkingError')
  ) {
    return new IngestWorkerError('MATERIAL_INVALID', 'Source material cannot be processed', {
      cause: error,
      retryable: false,
    });
  }
  if (isAbortError(error)) {
    return new IngestWorkerError('INGEST_CANCELLED', 'Knowledge ingestion was cancelled', {
      cause: error,
      retryable: true,
    });
  }
  return new IngestWorkerError(
    'INGEST_DEPENDENCY_FAILED',
    'Knowledge ingestion dependency failed',
    {
      cause: error,
      retryable: true,
    },
  );
}

function hasAdapterErrorShape(
  error: unknown,
): error is Error & { readonly code: string; readonly retryable: boolean } {
  const candidate = error as { readonly code?: unknown; readonly retryable?: unknown };
  return (
    error instanceof Error &&
    typeof candidate.code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,79}$/u.test(candidate.code) &&
    typeof candidate.retryable === 'boolean'
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || /abort|cancel/iu.test(error.message))
  );
}
