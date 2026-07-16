import type { PlatformCode } from '@geo-content-os/contracts';
import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';

export type PlatformConfigStatus = 'draft' | 'published' | 'retired';

export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: uuid().primaryKey().defaultRandom(),
    skillName: varchar('skill_name', { length: 80 }).notNull(),
    semanticVersion: varchar('version', { length: 32 }).notNull(),
    schemaVersion: varchar('schema_version', { length: 32 }).notNull(),
    systemPrompt: text('system_prompt').notNull(),
    taskTemplate: text('task_template').notNull(),
    contentHash: char('content_hash', { length: 64 }).notNull(),
    changeSummary: varchar('change_summary', { length: 500 })
      .notNull()
      .default('Imported legacy version'),
    status: varchar({ length: 16 }).$type<PlatformConfigStatus>().notNull().default('draft'),
    createdBy: uuid('created_by').notNull(),
    publishedBy: uuid('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lockVersion: integer('lock_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('prompt_versions_skill_version_uq').on(table.skillName, table.semanticVersion),
    unique('prompt_versions_content_hash_key').on(table.contentHash),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'prompt_versions_created_by_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.publishedBy],
      foreignColumns: [users.id],
      name: 'prompt_versions_published_by_fk',
    }).onDelete('restrict'),
    index('prompt_versions_status_created_idx').on(
      table.status,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check('prompt_versions_lock_version_check', sql`${table.lockVersion} > 0`),
    check(
      'prompt_versions_change_summary_check',
      sql`char_length(btrim(${table.changeSummary})) BETWEEN 1 AND 500`,
    ),
  ],
);

export const platformRuleVersions = pgTable(
  'platform_rule_versions',
  {
    id: uuid().primaryKey().defaultRandom(),
    platformCode: varchar('platform_code', { length: 24 }).$type<PlatformCode>().notNull(),
    semanticVersion: varchar('version', { length: 32 }).notNull(),
    rulesJson: jsonb('rules_json').$type<Record<string, unknown>>().notNull(),
    contentHash: char('content_hash', { length: 64 }).notNull(),
    changeSummary: varchar('change_summary', { length: 500 })
      .notNull()
      .default('Imported legacy version'),
    status: varchar({ length: 16 }).$type<PlatformConfigStatus>().notNull().default('draft'),
    createdBy: uuid('created_by').notNull(),
    publishedBy: uuid('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lockVersion: integer('lock_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('platform_rule_versions_platform_version_uq').on(
      table.platformCode,
      table.semanticVersion,
    ),
    unique('platform_rule_versions_content_hash_key').on(table.contentHash),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'platform_rule_versions_created_by_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.publishedBy],
      foreignColumns: [users.id],
      name: 'platform_rule_versions_published_by_fk',
    }).onDelete('restrict'),
    index('platform_rule_versions_status_created_idx').on(
      table.status,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check('platform_rule_versions_lock_version_check', sql`${table.lockVersion} > 0`),
    check(
      'platform_rule_versions_change_summary_check',
      sql`char_length(btrim(${table.changeSummary})) BETWEEN 1 AND 500`,
    ),
  ],
);
