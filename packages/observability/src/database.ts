import { createHash } from 'node:crypto';

import type { StructuredLogger } from './logger.js';

export function createDatabaseDebugLogger(logger: StructuredLogger) {
  return (connection: number, query: string): void => {
    const normalizedQuery = query.replaceAll(/\s+/gu, ' ').trim();
    logger.debug('PostgreSQL query started', {
      connection_id: connection,
      db_operation: normalizedQuery.split(' ', 1)[0]?.toUpperCase() ?? 'UNKNOWN',
      event: 'db.query.started',
      query_hash: createHash('sha256').update(normalizedQuery).digest('hex'),
    });
  };
}
