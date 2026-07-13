import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';

describe('PostgreSQL Testcontainers smoke', () => {
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it('applies the frozen extensions migration once', async () => {
    if (!container) {
      throw new Error('PostgreSQL test container did not start');
    }

    const client = postgres(container.getConnectionUri(), { max: 1 });

    try {
      const extensions = await client<{ extname: string }[]>`
        SELECT extname
        FROM pg_extension
        WHERE extname IN ('citext', 'pgcrypto', 'vector')
        ORDER BY extname
      `;
      const migrationRows = await client<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM public.__drizzle_migrations
      `;

      expect(extensions.map(({ extname }) => extname)).toEqual(['citext', 'pgcrypto', 'vector']);
      expect(migrationRows[0]?.count).toBe(1);
    } finally {
      await client.end();
    }
  });
});
