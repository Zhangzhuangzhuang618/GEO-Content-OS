import { UuidSchema } from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type postgres from 'postgres';

import { IdempotencyDatabase } from './idempotency.database.js';
import { IdempotencyConflictError, IdempotencyProcessingError } from './idempotency.errors.js';
import { parseIdempotencyKey } from './idempotency-key.js';
import type {
  CachedHttpResponse,
  IdempotencyExecutionInput,
  IdempotencyExecutionResult,
  IdempotencyTransaction,
  JsonValue,
} from './idempotency.types.js';
import { canonicalJson, hashRequest } from './request-hash.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const PROCESSING_STALE_AFTER_MS = 5 * 60 * 1_000;

interface IdempotencyRow {
  readonly id: string;
  readonly request_hash: string;
  readonly status: 'processing' | 'completed' | 'failed';
  readonly response_status: number | null;
  readonly response_json: JsonValue | null;
  readonly expired: boolean;
  readonly processing_stale: boolean;
}

@Injectable()
export class IdempotencyService {
  public constructor(
    @Inject(IdempotencyDatabase)
    private readonly database: IdempotencyDatabase | postgres.Sql,
  ) {}

  public async execute<TBody extends JsonValue>(
    input: IdempotencyExecutionInput,
    operation: (transaction: IdempotencyTransaction) => Promise<CachedHttpResponse<TBody>>,
  ): Promise<IdempotencyExecutionResult<TBody>> {
    const tenantId = UuidSchema.parse(input.tenantId);
    const scopeKey = parseScopeKey(input.scopeKey);
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    const requestHash = hashRequest(input.fingerprint);
    const ttlMs = normalizeTtl(input.ttlMs);

    return this.client.begin(async (transaction) => {
      let owned = await insertProcessingRecord(transaction, {
        idempotencyKey,
        requestHash,
        scopeKey,
        tenantId,
        ttlMs,
      });

      if (!owned) {
        const existing = await lockRecord(transaction, tenantId, scopeKey, idempotencyKey);
        if (!existing) {
          throw new Error('Idempotency record disappeared while acquiring its lock');
        }

        if (existing.expired || (existing.status === 'processing' && existing.processing_stale)) {
          await transaction`DELETE FROM idempotency_records WHERE id = ${existing.id}::uuid`;
          owned = await insertProcessingRecord(transaction, {
            idempotencyKey,
            requestHash,
            scopeKey,
            tenantId,
            ttlMs,
          });
          if (!owned) {
            throw new Error('Failed to replace an expired idempotency record');
          }
        } else {
          if (existing.request_hash !== requestHash) {
            throw new IdempotencyConflictError(scopeKey, idempotencyKey);
          }

          if (existing.status === 'processing') {
            throw new IdempotencyProcessingError();
          }

          if (existing.response_status === null) {
            throw new Error('Completed idempotency record is missing its response status');
          }

          return {
            outcome: 'replayed',
            requestHash,
            response: {
              body: existing.response_json as TBody,
              statusCode: existing.response_status,
            },
          };
        }
      }

      const response = await operation(transaction);
      assertResponse(response);
      const terminalStatus = response.statusCode >= 500 ? 'failed' : 'completed';
      const updated = await transaction<{ id: string }[]>`
        UPDATE idempotency_records
        SET
          status = ${terminalStatus},
          response_status = ${response.statusCode},
          response_json = ${JSON.stringify(response.body)}::text::jsonb
        WHERE tenant_id = ${tenantId}::uuid
          AND scope_key = ${scopeKey}
          AND idempotency_key = ${idempotencyKey}
          AND request_hash = ${requestHash}
          AND status = 'processing'
        RETURNING id
      `;
      if (updated.length !== 1) {
        throw new Error('Failed to finalize the owned idempotency record');
      }

      return { outcome: 'executed', requestHash, response };
    });
  }

  private get client(): postgres.Sql {
    return typeof this.database === 'function' ? this.database : this.database.client;
  }
}

interface InsertInput {
  readonly tenantId: string;
  readonly scopeKey: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly ttlMs: number;
}

async function insertProcessingRecord(
  transaction: IdempotencyTransaction,
  input: InsertInput,
): Promise<boolean> {
  const rows = await transaction<{ id: string }[]>`
    INSERT INTO idempotency_records (
      tenant_id,
      scope_key,
      idempotency_key,
      request_hash,
      status,
      expires_at
    ) VALUES (
      ${input.tenantId}::uuid,
      ${input.scopeKey},
      ${input.idempotencyKey},
      ${input.requestHash},
      'processing',
      now() + (${input.ttlMs} * interval '1 millisecond')
    )
    ON CONFLICT (tenant_id, scope_key, idempotency_key) DO NOTHING
    RETURNING id
  `;
  return rows.length === 1;
}

async function lockRecord(
  transaction: IdempotencyTransaction,
  tenantId: string,
  scopeKey: string,
  idempotencyKey: string,
): Promise<IdempotencyRow | undefined> {
  const rows = await transaction<IdempotencyRow[]>`
    SELECT
      id,
      request_hash,
      status,
      response_status,
      response_json,
      expires_at <= now() AS expired,
      updated_at <= now() - (${PROCESSING_STALE_AFTER_MS} * interval '1 millisecond')
        AS processing_stale
    FROM idempotency_records
    WHERE tenant_id = ${tenantId}::uuid
      AND scope_key = ${scopeKey}
      AND idempotency_key = ${idempotencyKey}
    FOR UPDATE
  `;
  return rows[0];
}

function parseScopeKey(value: string): string {
  const scope = value.trim();
  if (!scope || scope.length > 160) {
    throw new Error('scopeKey must contain between 1 and 160 characters');
  }
  return scope;
}

function normalizeTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAXIMUM_TTL_MS) {
    throw new Error('ttlMs must be a positive integer no greater than 7 days');
  }
  return ttl;
}

function assertResponse(response: CachedHttpResponse): void {
  if (
    !Number.isInteger(response.statusCode) ||
    response.statusCode < 100 ||
    response.statusCode > 599
  ) {
    throw new Error('Idempotent response statusCode must be an integer between 100 and 599');
  }
  canonicalJson(response.body);
}
