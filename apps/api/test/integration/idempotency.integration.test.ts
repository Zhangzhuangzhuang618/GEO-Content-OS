import {
  deterministicUuid,
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { setTimeout as delay } from 'node:timers/promises';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdempotencyConflictError } from '../../src/common/idempotency/idempotency.errors.js';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service.js';
import type { IdempotencyTransaction } from '../../src/common/idempotency/idempotency.types.js';
import { migrateDatabase } from '../../src/database/migrate.js';

describe('HTTP Idempotency-Key transaction coordinator', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let client: Sql | undefined;
  let service: IdempotencyService | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 10, prepare: false });
    service = new IdempotencyService(client);
    await client`
      INSERT INTO tenants (id, name, slug)
      VALUES (${deterministicUuid(1)}, '幂等测试租户', 'idempotency-test')
    `;
    await client`
      CREATE TABLE idempotency_test_effects (
        id uuid PRIMARY KEY,
        value text NOT NULL
      )
    `;
  }, 120_000);

  beforeEach(async () => {
    await requiredClient()`TRUNCATE TABLE idempotency_records, idempotency_test_effects`;
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('replays the original response without repeating the business write', async () => {
    const operation = vi.fn(businessOperation('first'));
    const input = requestInput('same-key', { title: 'Canonical title', tags: ['geo'] });

    const first = await requiredService().execute(input, operation);
    const replay = await requiredService().execute(
      requestInput('same-key', { tags: ['geo'], title: 'Canonical title' }),
      operation,
    );

    expect(first).toMatchObject({ outcome: 'executed', response: { statusCode: 201 } });
    expect(replay).toEqual({ ...first, outcome: 'replayed' });
    expect(operation).toHaveBeenCalledOnce();
    await expect(effectCount()).resolves.toBe(1);
  });

  it('rejects reuse of the same tenant, scope, and key with a different request hash', async () => {
    await requiredService().execute(
      requestInput('conflict-key', { title: 'First' }),
      businessOperation('first'),
    );

    await expect(
      requiredService().execute(
        requestInput('conflict-key', { title: 'Different' }),
        businessOperation('second'),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 });
    await expect(
      requiredService().execute(
        requestInput('conflict-key', { title: 'Different' }),
        businessOperation('second'),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(effectCount()).resolves.toBe(1);
  });

  it('serializes concurrent duplicate requests so only one operation executes', async () => {
    const operation = vi.fn(async (transaction: IdempotencyTransaction) => {
      await transaction`
        INSERT INTO idempotency_test_effects (id, value)
        VALUES (${deterministicUuid(301)}::uuid, 'concurrent')
      `;
      await delay(100);
      return { body: { id: deterministicUuid(301) }, statusCode: 202 } as const;
    });
    const input = requestInput('concurrent-key', { action: 'generate' });

    const results = await Promise.all([
      requiredService().execute(input, operation),
      requiredService().execute(input, operation),
    ]);

    expect(results.map(({ outcome }) => outcome).sort()).toEqual(['executed', 'replayed']);
    expect(operation).toHaveBeenCalledOnce();
    await expect(effectCount()).resolves.toBe(1);
  });

  it('rolls back the processing record and business write when the operation fails', async () => {
    const input = requestInput('rollback-key', { action: 'create' });
    await expect(
      requiredService().execute(input, async (transaction) => {
        await transaction`
          INSERT INTO idempotency_test_effects (id, value)
          VALUES (${deterministicUuid(302)}::uuid, 'rolled-back')
        `;
        throw new Error('business transaction failed');
      }),
    ).rejects.toThrow('business transaction failed');

    await expect(effectCount()).resolves.toBe(0);
    const retry = await requiredService().execute(input, businessOperation('retry'));
    expect(retry.outcome).toBe('executed');
    await expect(effectCount()).resolves.toBe(1);
  });

  it('allows an expired key to start a new request even when the hash changed', async () => {
    const database = requiredClient();
    await requiredService().execute(
      requestInput('expired-key', { version: 1 }),
      businessOperation('expired-first'),
    );
    await database`
      UPDATE idempotency_records
      SET
        created_at = now() - interval '2 hours',
        expires_at = now() - interval '1 hour'
      WHERE idempotency_key = 'expired-key'
    `;
    await database`TRUNCATE TABLE idempotency_test_effects`;

    const replaced = await requiredService().execute(
      requestInput('expired-key', { version: 2 }),
      businessOperation('expired-second'),
    );
    expect(replaced.outcome).toBe('executed');
    await expect(effectCount()).resolves.toBe(1);
  });

  it('stores and replays a 5xx result as failed without rerunning the operation', async () => {
    const operation = vi.fn(
      async () =>
        ({
          body: { error: { code: 'DEPENDENCY_UNAVAILABLE' } },
          statusCode: 503,
        }) as const,
    );
    const input = requestInput('failed-key', { action: 'schedule' });

    const first = await requiredService().execute(input, operation);
    const replay = await requiredService().execute(input, operation);
    const rows = await requiredClient()<{ status: string }[]>`
      SELECT status FROM idempotency_records WHERE idempotency_key = 'failed-key'
    `;

    expect(first.outcome).toBe('executed');
    expect(replay).toEqual({ ...first, outcome: 'replayed' });
    expect(rows[0]?.status).toBe('failed');
    expect(operation).toHaveBeenCalledOnce();
  });

  function businessOperation(value: string) {
    return async (transaction: IdempotencyTransaction) => {
      const id = deterministicUuid(400 + value.length);
      await transaction`
        INSERT INTO idempotency_test_effects (id, value)
        VALUES (${id}::uuid, ${value})
      `;
      return { body: { id, value }, statusCode: 201 } as const;
    };
  }

  async function effectCount(): Promise<number> {
    const rows = await requiredClient()<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM idempotency_test_effects
    `;
    return rows[0]?.count ?? -1;
  }

  function requiredClient(): Sql {
    if (!client) throw new Error('PostgreSQL test client did not start');
    return client;
  }

  function requiredService(): IdempotencyService {
    if (!service) throw new Error('Idempotency service did not start');
    return service;
  }
});

function requestInput(idempotencyKey: string, body: Record<string, string | number | string[]>) {
  return {
    fingerprint: {
      body,
      method: 'POST',
      path: '/api/v1/content-packages',
    },
    idempotencyKey,
    scopeKey: `${deterministicUuid(2)}:POST:/content-packages`,
    tenantId: deterministicUuid(1),
    ttlMs: 60_000,
  } as const;
}
