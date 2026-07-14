import type {
  BriefConstraints,
  ContentPackageStatus,
  ContentVariantStatus,
  PlatformCode,
} from '@geo-content-os/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { memberships, users } from './identity.js';
import { sourceChunks, sourceDocuments } from './knowledge.js';
import { generationRuns, keywords, projects, topicCandidates, workspaces } from './workspace.js';

export type BriefObjective = 'awareness' | 'conversion' | 'trust' | 'education';
export type GenerationMode = 'draft' | 'rewrite' | 'adapt' | 'repurpose';
export type ContentBlockType = 'heading' | 'paragraph' | 'list' | 'quote' | 'media' | 'cta';
export interface ContentDocument {
  readonly schema_version: string;
  readonly [key: string]: unknown;
}

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

export const contentPackages = pgTable(
  'content_packages',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    briefId: uuid('brief_id').notNull(),
    status: varchar({ length: 24 }).$type<ContentPackageStatus>().notNull().default('draft'),
    version: integer().notNull().default(1),
    masterContentVersionId: uuid('master_content_version_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('content_packages_id_tenant_uq').on(table.id, table.tenantId),
    unique('content_packages_id_scope_uq').on(
      table.id,
      table.tenantId,
      table.workspaceId,
      table.projectId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.tenantId],
      foreignColumns: [workspaces.id, workspaces.tenantId],
      name: 'content_packages_workspace_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.projectId, table.tenantId, table.workspaceId],
      foreignColumns: [projects.id, projects.tenantId, projects.workspaceId],
      name: 'content_packages_project_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.briefId, table.tenantId, table.workspaceId, table.projectId],
      foreignColumns: [briefs.id, briefs.tenantId, briefs.workspaceId, briefs.projectId],
      name: 'content_packages_brief_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'content_packages_created_by_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.createdBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
      name: 'content_packages_created_by_membership_fk',
    }).onDelete('restrict'),
    index('content_packages_scope_status_idx')
      .on(
        table.tenantId,
        table.workspaceId,
        table.projectId,
        table.status,
        table.updatedAt.desc(),
        table.id,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    check(
      'content_packages_status_check',
      sql`${table.status} IN ('draft','generating','generated','all_failed','editing','in_review','rejected','approved','scheduled','publishing','publish_failed','published','cancelled','archived')`,
    ),
    check('content_packages_version_check', sql`${table.version} > 0`),
    check(
      'content_packages_deleted_status_check',
      sql`${table.deletedAt} IS NULL OR ${table.status} = 'archived'`,
    ),
  ],
);

export const contentVariants = pgTable(
  'content_variants',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    packageId: uuid('package_id').notNull(),
    platformCode: varchar('platform_code', { length: 24 }).$type<PlatformCode>().notNull(),
    currentContentVersionId: uuid('current_content_version_id'),
    status: varchar({ length: 24 }).$type<ContentVariantStatus>().notNull().default('draft'),
    isRequired: boolean('is_required').notNull().default(true),
    qualityScore: numeric('quality_score', { precision: 5, scale: 2 }),
    version: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('content_variants_id_tenant_uq').on(table.id, table.tenantId),
    unique('content_variants_id_package_uq').on(table.id, table.tenantId, table.packageId),
    unique('content_variants_package_platform_uq').on(
      table.tenantId,
      table.packageId,
      table.platformCode,
    ),
    foreignKey({
      columns: [table.packageId, table.tenantId],
      foreignColumns: [contentPackages.id, contentPackages.tenantId],
      name: 'content_variants_package_fk',
    }).onDelete('restrict'),
    index('content_variants_package_status_idx').on(
      table.tenantId,
      table.packageId,
      table.status,
      table.platformCode,
      table.id,
    ),
    check(
      'content_variants_platform_check',
      sql`${table.platformCode} IN ('official_site','baijiahao','toutiao','zhihu','xiaohongshu','wechat_mp','douyin')`,
    ),
    check(
      'content_variants_status_check',
      sql`${table.status} IN ('draft','generating','generation_failed','generated','quality_failed','quality_passed','in_review','review_approved','review_rejected','approved','scheduled','publishing','published','publish_failed','cancelled')`,
    ),
    check(
      'content_variants_quality_score_check',
      sql`${table.qualityScore} IS NULL OR ${table.qualityScore} BETWEEN 0 AND 100`,
    ),
    check('content_variants_version_check', sql`${table.version} > 0`),
  ],
);

export const contentVersions = pgTable(
  'content_versions',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    packageId: uuid('package_id').notNull(),
    variantId: uuid('variant_id'),
    versionNo: integer('version_no').notNull(),
    schemaVersion: varchar('schema_version', { length: 32 }).notNull(),
    contentJson: jsonb('content_json').$type<ContentDocument>().notNull(),
    contentHash: char('content_hash', { length: 64 }).notNull(),
    sourceRunId: uuid('source_run_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('content_versions_id_tenant_uq').on(table.id, table.tenantId),
    unique('content_versions_id_package_variant_uq').on(
      table.id,
      table.tenantId,
      table.packageId,
      table.variantId,
    ),
    uniqueIndex('content_versions_object_version_uq').on(
      table.tenantId,
      table.packageId,
      sql`COALESCE(${table.variantId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      table.versionNo,
    ),
    uniqueIndex('content_versions_object_hash_uq').on(
      table.tenantId,
      table.packageId,
      sql`COALESCE(${table.variantId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      table.contentHash,
    ),
    foreignKey({
      columns: [table.packageId, table.tenantId],
      foreignColumns: [contentPackages.id, contentPackages.tenantId],
      name: 'content_versions_package_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.variantId, table.tenantId, table.packageId],
      foreignColumns: [contentVariants.id, contentVariants.tenantId, contentVariants.packageId],
      name: 'content_versions_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.sourceRunId, table.tenantId],
      foreignColumns: [generationRuns.id, generationRuns.tenantId],
      name: 'content_versions_source_run_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'content_versions_created_by_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.createdBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
      name: 'content_versions_created_by_membership_fk',
    }).onDelete('restrict'),
    index('content_versions_object_created_idx').on(
      table.tenantId,
      table.packageId,
      table.variantId,
      table.versionNo.desc(),
    ),
    check('content_versions_version_no_check', sql`${table.versionNo} > 0`),
    check(
      'content_versions_schema_version_check',
      sql`char_length(btrim(${table.schemaVersion})) BETWEEN 1 AND 32`,
    ),
    check(
      'content_versions_content_check',
      sql`COALESCE(jsonb_typeof(${table.contentJson}) = 'object' AND ${table.contentJson}->>'schema_version' = ${table.schemaVersion}, false)`,
    ),
    check('content_versions_content_hash_check', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const contentBlocks = pgTable(
  'content_blocks',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    contentVersionId: uuid('content_version_id').notNull(),
    blockKey: varchar('block_key', { length: 80 }).notNull(),
    blockType: varchar('block_type', { length: 24 }).$type<ContentBlockType>().notNull(),
    position: integer().notNull(),
    textHash: char('text_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('content_blocks_version_key_uq').on(
      table.tenantId,
      table.contentVersionId,
      table.blockKey,
    ),
    unique('content_blocks_version_position_uq').on(
      table.tenantId,
      table.contentVersionId,
      table.position,
    ),
    foreignKey({
      columns: [table.contentVersionId, table.tenantId],
      foreignColumns: [contentVersions.id, contentVersions.tenantId],
      name: 'content_blocks_version_fk',
    }).onDelete('cascade'),
    check('content_blocks_key_check', sql`char_length(btrim(${table.blockKey})) BETWEEN 1 AND 80`),
    check(
      'content_blocks_type_check',
      sql`${table.blockType} IN ('heading','paragraph','list','quote','media','cta')`,
    ),
    check('content_blocks_position_check', sql`${table.position} >= 0`),
    check('content_blocks_text_hash_check', sql`${table.textHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const contentBlockLocks = pgTable(
  'content_block_locks',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    blockKey: varchar('block_key', { length: 80 }).notNull(),
    lockedContentHash: char('locked_content_hash', { length: 64 }).notNull(),
    lockedBy: uuid('locked_by').notNull(),
    reason: text(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('content_block_locks_variant_key_uq').on(
      table.tenantId,
      table.variantId,
      table.blockKey,
    ),
    foreignKey({
      columns: [table.variantId, table.tenantId],
      foreignColumns: [contentVariants.id, contentVariants.tenantId],
      name: 'content_block_locks_variant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.lockedBy],
      foreignColumns: [users.id],
      name: 'content_block_locks_locked_by_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.lockedBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
      name: 'content_block_locks_locked_by_membership_fk',
    }).onDelete('restrict'),
    check(
      'content_block_locks_key_check',
      sql`char_length(btrim(${table.blockKey})) BETWEEN 1 AND 80`,
    ),
    check('content_block_locks_hash_check', sql`${table.lockedContentHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'content_block_locks_reason_check',
      sql`${table.reason} IS NULL OR char_length(btrim(${table.reason})) BETWEEN 1 AND 1000`,
    ),
  ],
);

export const aiCitations = pgTable(
  'ai_citations',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    contentVersionId: uuid('content_version_id').notNull(),
    claimKey: varchar('claim_key', { length: 80 }).notNull(),
    claimText: text('claim_text').notNull(),
    chunkId: uuid('chunk_id').notNull(),
    quoteText: text('quote_text').notNull(),
    quoteHash: char('quote_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('ai_citations_claim_chunk_quote_uq').on(
      table.tenantId,
      table.contentVersionId,
      table.claimKey,
      table.chunkId,
      table.quoteHash,
    ),
    foreignKey({
      columns: [table.contentVersionId, table.tenantId],
      foreignColumns: [contentVersions.id, contentVersions.tenantId],
      name: 'ai_citations_version_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.chunkId, table.tenantId],
      foreignColumns: [sourceChunks.id, sourceChunks.tenantId],
      name: 'ai_citations_chunk_fk',
    }).onDelete('restrict'),
    index('ai_citations_chunk_idx').on(table.tenantId, table.chunkId, table.contentVersionId),
    check(
      'ai_citations_claim_key_check',
      sql`char_length(btrim(${table.claimKey})) BETWEEN 1 AND 80`,
    ),
    check('ai_citations_claim_text_check', sql`char_length(btrim(${table.claimText})) > 0`),
    check('ai_citations_quote_text_check', sql`char_length(btrim(${table.quoteText})) > 0`),
    check('ai_citations_quote_hash_check', sql`${table.quoteHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type BriefRecord = typeof briefs.$inferSelect;
export type BriefKeywordRecord = typeof briefKeywords.$inferSelect;
export type BriefSourceRecord = typeof briefSources.$inferSelect;
export type ContentPackageRecord = typeof contentPackages.$inferSelect;
export type ContentVariantRecord = typeof contentVariants.$inferSelect;
export type ContentVersionRecord = typeof contentVersions.$inferSelect;
export type ContentBlockRecord = typeof contentBlocks.$inferSelect;
export type ContentBlockLockRecord = typeof contentBlockLocks.$inferSelect;
export type AiCitationRecord = typeof aiCitations.$inferSelect;
