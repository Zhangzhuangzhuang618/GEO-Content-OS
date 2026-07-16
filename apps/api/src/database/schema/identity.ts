import type { PlatformRoleCode, TenantRoleCode } from '@geo-content-os/contracts';
import { sql } from 'drizzle-orm';
import {
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const inet = customType<{ data: string }>({ dataType: () => 'inet' });

export type UserStatus = 'invited' | 'active' | 'disabled';
export type PlatformRoleStatus = 'active' | 'disabled';
export type TenantStatus = 'active' | 'suspended' | 'archived';
export type MembershipStatus = 'invited' | 'active' | 'disabled';

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: citext().notNull(),
    passwordHash: varchar('password_hash', { length: 255 }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    displayName: varchar('display_name', { length: 80 }).notNull(),
    status: varchar({ length: 16 }).$type<UserStatus>().notNull().default('invited'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('users_email_active_uq')
      .on(table.email)
      .where(sql`${table.deletedAt} IS NULL`),
    index('users_status_idx')
      .on(table.status, table.createdAt)
      .where(sql`${table.deletedAt} IS NULL`),
    check(
      'users_display_name_check',
      sql`char_length(btrim(${table.displayName})) BETWEEN 1 AND 80`,
    ),
    check('users_status_check', sql`${table.status} IN ('invited', 'active', 'disabled')`),
  ],
);

export const platformRoles = pgTable(
  'platform_roles',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    roleCode: varchar('role_code', { length: 32 }).$type<PlatformRoleCode>().notNull(),
    status: varchar({ length: 16 }).$type<PlatformRoleStatus>().notNull().default('active'),
    grantedBy: uuid('granted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'platform_roles_user_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.grantedBy],
      foreignColumns: [users.id],
      name: 'platform_roles_granted_by_fk',
    }).onDelete('set null'),
    index('platform_roles_user_status_idx').on(table.userId, table.status),
    check(
      'platform_roles_role_code_check',
      sql`${table.roleCode} IN ('platform_admin', 'platform_operator')`,
    ),
    check('platform_roles_status_check', sql`${table.status} IN ('active', 'disabled')`),
  ],
);

export const tenants = pgTable(
  'tenants',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: varchar({ length: 120 }).notNull(),
    slug: citext().notNull(),
    planCode: varchar('plan_code', { length: 32 }).notNull().default('trial'),
    timezone: varchar({ length: 64 }).notNull().default('Asia/Shanghai'),
    status: varchar({ length: 16 }).$type<TenantStatus>().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('tenants_slug_active_uq')
      .on(table.slug)
      .where(sql`${table.deletedAt} IS NULL`),
    index('tenants_status_idx')
      .on(table.status, table.createdAt)
      .where(sql`${table.deletedAt} IS NULL`),
    check('tenants_status_check', sql`${table.status} IN ('active', 'suspended', 'archived')`),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    roleCode: varchar('role_code', { length: 32 }).$type<TenantRoleCode>().notNull(),
    status: varchar({ length: 16 }).$type<MembershipStatus>().notNull().default('invited'),
    version: integer().notNull().default(1),
    invitedBy: uuid('invited_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('memberships_id_tenant_uq').on(table.id, table.tenantId),
    unique('memberships_tenant_user_uq').on(table.tenantId, table.userId),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: 'memberships_tenant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'memberships_user_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.invitedBy],
      foreignColumns: [users.id],
      name: 'memberships_invited_by_fk',
    }).onDelete('set null'),
    index('memberships_user_status_idx').on(table.userId, table.status, table.updatedAt.desc()),
    index('memberships_tenant_status_idx').on(table.tenantId, table.status, table.createdAt),
    index('memberships_tenant_version_idx').on(table.tenantId, table.id, table.version),
    check(
      'memberships_role_code_check',
      sql`${table.roleCode} IN ('tenant_owner', 'tenant_admin', 'strategy_editor', 'content_editor', 'reviewer', 'publisher', 'analyst', 'viewer')`,
    ),
    check('memberships_status_check', sql`${table.status} IN ('invited', 'active', 'disabled')`),
    check('memberships_version_check', sql`${table.version} > 0`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    activeTenantId: uuid('active_tenant_id'),
    sessionHash: char('session_hash', { length: 64 }).notNull(),
    csrfHash: char('csrf_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ip: inet(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'sessions_user_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.activeTenantId, table.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
      name: 'sessions_active_membership_fk',
    }).onDelete('restrict'),
    unique('sessions_session_hash_uq').on(table.sessionHash),
    index('sessions_user_valid_idx')
      .on(table.userId, table.expiresAt.desc())
      .where(sql`${table.revokedAt} IS NULL`),
    index('sessions_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
    check('sessions_session_hash_check', sql`${table.sessionHash} ~ '^[0-9a-f]{64}$'`),
    check('sessions_csrf_hash_check', sql`${table.csrfHash} ~ '^[0-9a-f]{64}$'`),
    check('sessions_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    email: citext().notNull(),
    roleCode: varchar('role_code', { length: 32 }).$type<TenantRoleCode>().notNull(),
    workspaceScopeJson: jsonb('workspace_scope_json').notNull().default({}),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    invitedBy: uuid('invited_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('invitations_id_tenant_uq').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: 'invitations_tenant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.invitedBy],
      foreignColumns: [users.id],
      name: 'invitations_invited_by_fk',
    }).onDelete('restrict'),
    unique('invitations_token_hash_uq').on(table.tokenHash),
    index('invitations_tenant_pending_idx')
      .on(table.tenantId, table.email, table.expiresAt.desc())
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    uniqueIndex('invitations_tenant_email_pending_uq')
      .on(table.tenantId, table.email)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    index('invitations_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    check(
      'invitations_role_code_check',
      sql`${table.roleCode} IN ('tenant_owner', 'tenant_admin', 'strategy_editor', 'content_editor', 'reviewer', 'publisher', 'analyst', 'viewer')`,
    ),
    check('invitations_token_hash_check', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('invitations_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'invitations_terminal_state_check',
      sql`${table.acceptedAt} IS NULL OR ${table.revokedAt} IS NULL`,
    ),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'password_reset_tokens_user_fk',
    }).onDelete('cascade'),
    unique('password_reset_tokens_token_hash_uq').on(table.tokenHash),
    index('password_reset_tokens_user_pending_idx')
      .on(table.userId, table.expiresAt.desc())
      .where(sql`${table.usedAt} IS NULL`),
    index('password_reset_tokens_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.usedAt} IS NULL`),
    check('password_reset_tokens_token_hash_check', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('password_reset_tokens_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'password_reset_tokens_used_at_check',
      sql`${table.usedAt} IS NULL OR ${table.usedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type UserRecord = typeof users.$inferSelect;
export type PlatformRoleRecord = typeof platformRoles.$inferSelect;
export type TenantRecord = typeof tenants.$inferSelect;
export type MembershipRecord = typeof memberships.$inferSelect;
export type SessionRecord = typeof sessions.$inferSelect;
export type InvitationRecord = typeof invitations.$inferSelect;
export type PasswordResetTokenRecord = typeof passwordResetTokens.$inferSelect;
