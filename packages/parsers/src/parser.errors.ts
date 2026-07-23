import type { ParserErrorCode } from './parser.types.js';

export class MaterialParserError extends Error {
  public constructor(
    public readonly code: ParserErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MaterialParserError';
  }
}
