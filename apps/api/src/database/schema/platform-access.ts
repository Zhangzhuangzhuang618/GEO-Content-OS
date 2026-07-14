import type { PermissionCode } from '@geo-content-os/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { tenants, users } from './identity.js';

const inet = customType<{ data: string }>({ dataType: () => 'inet' });

export interface SupportAccessScope {
  readonly permissions: readonly PermissionCode[];
  readonly resource_types: readonly string[];
  readonly schema_version: 'support-access@1';
}

export const supportAccessGrants = pgTable(
  'support_access_grants',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    platformUserId: uuid('platform_user_id').notNull(),
    scopeJson: jsonb('scope_json').$type<SupportAccessScope>().notNull(),
    reason: text().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    grantedBy: uuid('granted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: 'support_access_grants_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.platformUserId],
      foreignColumns: [users.id],
      name: 'support_access_grants_platform_user_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.grantedBy],
      foreignColumns: [users.id],
      name: 'support_access_grants_granted_by_fk',
    }).onDelete('restrict'),
    index('support_access_grants_active_lookup_idx')
      .on(table.platformUserId, table.tenantId, table.expiresAt.desc())
      .where(sql`${table.revokedAt} IS NULL`),
    index('support_access_grants_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    check(
      'support_access_grants_reason_check',
      sql`char_length(btrim(${table.reason})) BETWEEN 1 AND 2000`,
    ),
    check(
      'support_access_grants_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '8 hours'`,
    ),
    check(
      'support_access_grants_revoked_at_check',
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
    ),
    check(
      'support_access_grants_scope_check',
      sql`COALESCE(jsonb_typeof(${table.scopeJson}) = 'object'
        AND ${table.scopeJson}->>'schema_version' = 'support-access@1'
        AND ${table.scopeJson} - ARRAY['schema_version', 'permissions', 'resource_types'] = '{}'::jsonb
        AND jsonb_typeof(${table.scopeJson}->'permissions') = 'array'
        AND jsonb_array_length(${table.scopeJson}->'permissions') BETWEEN 1 AND 32
        AND NOT jsonb_path_exists(${table.scopeJson}, '$.permissions[*] ? (@.type() != "string" || @ == "")')
        AND jsonb_typeof(${table.scopeJson}->'resource_types') = 'array'
        AND jsonb_array_length(${table.scopeJson}->'resource_types') BETWEEN 1 AND 64
        AND NOT jsonb_path_exists(${table.scopeJson}, '$.resource_types[*] ? (@.type() != "string" || @ == "")'), false)`,
    ),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    actorId: uuid('actor_id'),
    supportAccessGrantId: uuid('support_access_grant_id'),
    action: varchar({ length: 80 }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }).notNull(),
    resourceId: uuid('resource_id'),
    beforeJson: jsonb('before_json'),
    afterJson: jsonb('after_json'),
    ip: inet(),
    requestId: varchar('request_id', { length: 80 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('audit_events_id_tenant_uq').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: 'audit_events_tenant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [users.id],
      name: 'audit_events_actor_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.supportAccessGrantId],
      foreignColumns: [supportAccessGrants.id],
      name: 'audit_events_support_access_grant_fk',
    }).onDelete('restrict'),
    index('audit_events_tenant_created_idx').on(
      table.tenantId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('audit_events_resource_time_idx').on(
      table.tenantId,
      table.resourceType,
      table.resourceId,
      table.createdAt.desc(),
    ),
    index('audit_events_support_access_idx')
      .on(table.supportAccessGrantId, table.createdAt.desc())
      .where(sql`${table.supportAccessGrantId} IS NOT NULL`),
    index('audit_events_request_id_idx').on(table.requestId, table.createdAt.desc()),
    check('audit_events_action_check', sql`char_length(btrim(${table.action})) BETWEEN 1 AND 80`),
    check(
      'audit_events_resource_type_check',
      sql`char_length(btrim(${table.resourceType})) BETWEEN 1 AND 64`,
    ),
    check(
      'audit_events_request_id_check',
      sql`char_length(btrim(${table.requestId})) BETWEEN 1 AND 80`,
    ),
  ],
);

export type SupportAccessGrantRecord = typeof supportAccessGrants.$inferSelect;
export type AuditEventRecord = typeof auditEvents.$inferSelect;
