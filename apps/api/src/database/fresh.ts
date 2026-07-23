import { assertFreshDatabaseAllowed, readDatabaseUrl } from './config.js';
import { createDatabaseConnection } from './connection.js';
import { migrateDatabase } from './migrate.js';

export async function migrateFreshDatabase(force: boolean): Promise<void> {
  const databaseUrl = readDatabaseUrl();
  assertFreshDatabaseAllowed(databaseUrl, { force });

  const connection = createDatabaseConnection(databaseUrl);
  try {
    await connection.client.unsafe(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO CURRENT_USER;
      GRANT USAGE ON SCHEMA public TO PUBLIC;
    `);
  } finally {
    await connection.client.end();
  }

  await migrateDatabase(databaseUrl);
}
