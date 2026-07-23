import type { DatabaseClient } from './connection.js';

export interface DatabaseClientProvider {
  readonly client: DatabaseClient;
}

export type DatabaseClientSource = DatabaseClient | DatabaseClientProvider;

export function resolveDatabaseClient(source: DatabaseClientSource): DatabaseClient {
  return typeof source === 'function' ? source : source.client;
}
