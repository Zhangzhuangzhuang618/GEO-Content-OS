import { drizzle } from 'drizzle-orm/postgres-js';
import type { StructuredLogger } from '@geo-content-os/observability';
import postgres from 'postgres';

import { createPostgresDebugLogger } from '../common/telemetry/database-telemetry.js';
import { readDatabaseUrl } from './config.js';

export type DatabaseClient = ReturnType<typeof postgres>;
export type Database = ReturnType<typeof drizzle>;

export interface DatabaseConnection {
  readonly client: DatabaseClient;
  readonly database: Database;
}

export interface DatabaseConnectionOptions {
  readonly telemetryLogger?: StructuredLogger;
}

export function createDatabaseConnection(
  databaseUrl = readDatabaseUrl(),
  options: DatabaseConnectionOptions = {},
): DatabaseConnection {
  const client = postgres(databaseUrl, {
    connect_timeout: 10,
    debug: options.telemetryLogger ? createPostgresDebugLogger(options.telemetryLogger) : false,
    idle_timeout: 20,
    max: 10,
    prepare: false,
  });

  return {
    client,
    database: drizzle(client),
  };
}
