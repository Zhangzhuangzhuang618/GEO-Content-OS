import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';

import { createDatabaseConnection } from './connection.js';
import { assertRequiredExtensions } from './extensions.js';

export const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));
export const migrationsSchema = 'public';
export const migrationsTable = '__drizzle_migrations';

export async function migrateDatabase(databaseUrl?: string): Promise<void> {
  const connection = createDatabaseConnection(databaseUrl);

  try {
    await migrate(connection.database, {
      migrationsFolder,
      migrationsSchema,
      migrationsTable,
    });
    await assertRequiredExtensions(connection.client);
  } finally {
    await connection.client.end();
  }
}
