import type { IdempotencyScopeInput } from './idempotency.types.js';

const MAX_KEY_LENGTH = 160;
const PRINTABLE_ASCII = /^[!-~]+$/u;

export function parseIdempotencyKey(value: string | readonly string[] | undefined): string {
  if (value === undefined) {
    throw new IdempotencyKeyValidationError('Idempotency-Key is required');
  }

  if (typeof value !== 'string') {
    if (value.length !== 1) {
      throw new IdempotencyKeyValidationError('Idempotency-Key must be sent exactly once');
    }
    return parseIdempotencyKey(value[0]);
  }

  const key = value.trim();
  if (!key) {
    throw new IdempotencyKeyValidationError('Idempotency-Key is required');
  }
  if (key.length > MAX_KEY_LENGTH || !PRINTABLE_ASCII.test(key)) {
    throw new IdempotencyKeyValidationError(
      'Idempotency-Key must contain 1 to 160 printable ASCII characters without whitespace',
    );
  }

  return key;
}

export function buildIdempotencyScope(input: IdempotencyScopeInput): string {
  const actorId = input.actorId.trim();
  const method = input.method.trim().toUpperCase();
  const route = input.route.trim();
  if (!actorId || !method || !route) {
    throw new IdempotencyKeyValidationError('Idempotency scope requires actor, method, and route');
  }

  const scope = `${actorId}:${method}:${route}`;
  if (scope.length > MAX_KEY_LENGTH) {
    throw new IdempotencyKeyValidationError('Idempotency scope must not exceed 160 characters');
  }

  return scope;
}

export class IdempotencyKeyValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IdempotencyKeyValidationError';
  }
}
