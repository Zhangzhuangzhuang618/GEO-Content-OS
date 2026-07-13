import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { readDatabaseUrl } from './config.js';

export type DatabaseClient = ReturnType<typeof postgres>;
export type Database = ReturnType<typeof drizzle>;

export interface DatabaseConnection {
  readonly client: DatabaseClient;
  readonly database: Database;
}

export function createDatabaseConnection(databaseUrl = readDatabaseUrl()): DatabaseConnection {
  const client = postgres(databaseUrl, {
    connect_timeout: 10,
    idle_timeout: 20,
    max: 10,
    prepare: false,
  });

  return {
    client,
    database: drizzle(client),
  };
}
