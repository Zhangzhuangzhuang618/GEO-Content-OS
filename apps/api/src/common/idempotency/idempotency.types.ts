import type postgres from 'postgres';

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface RequestFingerprint {
  readonly method: string;
  readonly path: string;
  readonly query?: JsonValue;
  readonly body?: JsonValue;
}

export interface CachedHttpResponse<TBody extends JsonValue = JsonValue> {
  readonly statusCode: number;
  /** Must be safe to persist and replay; never include secrets or raw credentials. */
  readonly body: TBody;
}

export interface IdempotencyExecutionInput {
  /** Null identifies a global platform-scoped operation. */
  readonly tenantId: string | null;
  readonly scopeKey: string;
  readonly idempotencyKey: string;
  readonly fingerprint: RequestFingerprint;
  readonly ttlMs?: number;
}

export interface IdempotencyExecutionResult<TBody extends JsonValue = JsonValue> {
  readonly outcome: 'executed' | 'replayed';
  readonly requestHash: string;
  readonly response: CachedHttpResponse<TBody>;
}

export type IdempotencyTransaction = postgres.TransactionSql;

export interface IdempotencyScopeInput {
  readonly actorId: string;
  readonly method: string;
  readonly route: string;
}
