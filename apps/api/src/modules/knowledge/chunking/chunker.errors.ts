export class ChunkingError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ChunkingError';
  }
}
