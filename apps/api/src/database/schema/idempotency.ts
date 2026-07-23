import { sql } from 'drizzle-orm';
import {
  char,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id'),
    scopeKey: varchar('scope_key', { length: 160 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    status: varchar({ length: 16 }).notNull().default('processing'),
    responseStatus: smallint('response_status'),
    responseJson: jsonb('response_json'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('idempotency_records_unique_key')
      .on(table.tenantId, table.scopeKey, table.idempotencyKey)
      .nullsNotDistinct(),
    check('idempotency_records_request_hash_check', sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'idempotency_records_status_check',
      sql`${table.status} IN ('processing', 'completed', 'failed')`,
    ),
    check(
      'idempotency_records_response_status_check',
      sql`${table.responseStatus} IS NULL OR ${table.responseStatus} BETWEEN 100 AND 599`,
    ),
    index('idempotency_records_expiry_idx').on(table.expiresAt),
    index('idempotency_records_tenant_expiry_idx').on(table.tenantId, table.expiresAt),
  ],
);

export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
