import {
  createStructuredLogger,
  initializeTelemetryContextManager,
  runWithTelemetryContext,
} from '@geo-content-os/observability';
import { describe, expect, it } from 'vitest';

import { createPostgresDebugLogger } from './database-telemetry.js';

describe('PostgreSQL telemetry', () => {
  it('logs a query fingerprint and correlation fields without parameter values', () => {
    initializeTelemetryContextManager();
    const lines: string[] = [];
    const logger = createStructuredLogger({
      destination: {
        write(chunk) {
          lines.push(String(chunk));
        },
      },
      environment: 'test',
      level: 'debug',
      service: 'api',
    });
    const debug = createPostgresDebugLogger(logger);

    runWithTelemetryContext({ requestId: 'request-db', tenantId: 'tenant-db' }, () => {
      debug(7, 'SELECT * FROM users WHERE email = $1');
    });

    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      connection_id: 7,
      db_operation: 'SELECT',
      event: 'db.query.started',
      request_id: 'request-db',
      tenant_id: 'tenant-db',
    });
    expect(record['query_hash']).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(record)).not.toContain('email =');
  });
});
