import type { BriefConstraints, PlatformCode } from '@geo-content-os/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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

import { memberships, users } from './identity.js';
import { sourceDocuments } from './knowledge.js';
import { keywords, projects, topicCandidates, workspaces } from './workspace.js';

export type BriefObjective = 'awareness' | 'conversion' | 'trust' | 'education';
export type GenerationMode = 'draft' | 'rewrite' | 'adapt' | 'repurpose';

export const briefs = pgTable(
  'briefs',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    sourceTopicCandidateId: uuid('source_topic_candidate_id'),
    title: varchar({ length: 240 }).notNull(),
    objective: varchar({ length: 32 }).$type<BriefObjective>().notNull(),
    audience: text().notNull(),
    platformCodes: varchar('platform_codes', { length: 24 })
      .array()
      .$type<PlatformCode[]>()
      .notNull(),
    constraintsJson: jsonb('constraints_json').$type<BriefConstraints>().notNull(),
    generationMode: varchar('generation_mode', { length: 16 })
      .$type<GenerationMode>()
      .notNull()
      .default('draft'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    version: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('briefs_id_tenant_uq').on(table.id, table.tenantId),
    unique('briefs_id_scope_uq').on(table.id, table.tenantId, table.workspaceId, table.projectId),
    unique('briefs_source_topic_uq').on(table.tenantId, table.sourceTopicCandidateId),
    foreignKey({
      columns: [table.workspaceId, table.tenantId],
      foreignColumns: [workspaces.id, workspaces.tenantId],
      name: 'briefs_workspace_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.projectId, table.tenantId, table.workspaceId],
      foreignColumns: [projects.id, projects.tenantId, projects.workspaceId],
      name: 'briefs_project_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.sourceTopicCandidateId, table.tenantId],
      foreignColumns: [topicCandidates.id, topicCandidates.tenantId],
      name: 'briefs_source_topic_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'briefs_created_by_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.createdBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
      name: 'briefs_created_by_membership_fk',
    }).onDelete('restrict'),
    index('briefs_scope_updated_idx')
      .on(table.tenantId, table.workspaceId, table.projectId, table.updatedAt.desc(), table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    check('briefs_title_check', sql`char_length(btrim(${table.title})) BETWEEN 2 AND 80`),
    check(
      'briefs_objective_check',
      sql`${table.objective} IN ('awareness', 'conversion', 'trust', 'education')`,
    ),
    check('briefs_audience_check', sql`char_length(btrim(${table.audience})) BETWEEN 10 AND 500`),
    check('briefs_platform_codes_check', sql`is_valid_platform_code_array(${table.platformCodes})`),
    check(
      'briefs_constraints_check',
      sql`COALESCE(jsonb_typeof(${table.constraintsJson}) = 'object' AND ${table.constraintsJson}->>'schema_version' = 'brief-constraints@1', false)`,
    ),
    check(
      'briefs_generation_mode_check',
      sql`${table.generationMode} IN ('draft', 'rewrite', 'adapt', 'repurpose')`,
    ),
    check('briefs_version_check', sql`${table.version} > 0`),
  ],
);

export const briefKeywords = pgTable(
  'brief_keywords',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    briefId: uuid('brief_id').notNull(),
    keywordId: uuid('keyword_id').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('brief_keywords_brief_keyword_uq').on(table.tenantId, table.briefId, table.keywordId),
    foreignKey({
      columns: [table.briefId, table.tenantId],
      foreignColumns: [briefs.id, briefs.tenantId],
      name: 'brief_keywords_brief_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.keywordId, table.tenantId],
      foreignColumns: [keywords.id, keywords.tenantId],
      name: 'brief_keywords_keyword_fk',
    }).onDelete('restrict'),
    uniqueIndex('brief_keywords_one_primary_uq')
      .on(table.tenantId, table.briefId)
      .where(sql`${table.isPrimary}`),
    index('brief_keywords_keyword_idx').on(table.tenantId, table.keywordId, table.briefId),
  ],
);

export const briefSources = pgTable(
  'brief_sources',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    briefId: uuid('brief_id').notNull(),
    sourceDocumentId: uuid('source_document_id').notNull(),
    required: boolean().notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('brief_sources_brief_source_uq').on(
      table.tenantId,
      table.briefId,
      table.sourceDocumentId,
    ),
    foreignKey({
      columns: [table.briefId, table.tenantId],
      foreignColumns: [briefs.id, briefs.tenantId],
      name: 'brief_sources_brief_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.sourceDocumentId, table.tenantId],
      foreignColumns: [sourceDocuments.id, sourceDocuments.tenantId],
      name: 'brief_sources_source_document_fk',
    }).onDelete('restrict'),
  ],
);

export type BriefRecord = typeof briefs.$inferSelect;
export type BriefKeywordRecord = typeof briefKeywords.$inferSelect;
export type BriefSourceRecord = typeof briefSources.$inferSelect;
