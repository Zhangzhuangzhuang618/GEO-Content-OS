import type {
  PlatformCode,
  WorkspaceSettings as ContractWorkspaceSettings,
} from '@geo-content-os/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  char,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { memberships, tenants, users } from './identity.js';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });

export type WorkspaceStatus = 'active' | 'archived';
export type ProjectStatus = 'active' | 'archived';
export type BrandProfileStatus = 'draft' | 'published' | 'retired';
export type KeywordSetStatus = 'active' | 'archived';
export type KeywordIntent = 'informational' | 'commercial' | 'transactional' | 'navigational';
export type KeywordStatus = 'active' | 'disabled';
export type GenerationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TopicRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type TopicCandidateStatus = 'proposed' | 'adopted' | 'archived';

export type WorkspaceSettings = ContractWorkspaceSettings | Record<string, never>;

export interface WorkspaceScope {
  readonly schema_version?: 'workspace-scope@1';
  readonly [key: string]: unknown;
}

export interface EntityList {
  readonly entities: readonly string[];
  readonly schema_version: 'entity-list@1';
}

export interface CitationSet {
  readonly evidence_ids: readonly string[];
  readonly schema_version: 'citation-set@1';
}

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    name: varchar({ length: 120 }).notNull(),
    slug: citext().notNull(),
    timezone: varchar({ length: 64 }).notNull(),
    settingsJson: jsonb('settings_json').$type<WorkspaceSettings>().notNull().default({}),
    status: varchar({ length: 16 }).$type<WorkspaceStatus>().notNull().default('active'),
    version: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('workspaces_id_tenant_uq').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: 'workspaces_tenant_fk',
    }).onDelete('restrict'),
    uniqueIndex('workspaces_tenant_slug_active_uq')
      .on(table.tenantId, table.slug)
      .where(sql`${table.deletedAt} IS NULL`),
    index('workspaces_tenant_status_idx')
      .on(table.tenantId, table.status, table.updatedAt.desc(), table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    check('workspaces_name_check', sql`char_length(btrim(${table.name})) BETWEEN 1 AND 120`),
    check(
      'workspaces_slug_check',
      sql`char_length(${table.slug}::text) BETWEEN 1 AND 80 AND ${table.slug}::text ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
    check('workspaces_timezone_check', sql`char_length(btrim(${table.timezone})) BETWEEN 1 AND 64`),
    check(
      'workspaces_settings_check',
      sql`COALESCE(jsonb_typeof(${table.settingsJson}) = 'object' AND (${table.settingsJson} = '{}'::jsonb OR ${table.settingsJson}->>'schema_version' = 'workspace-settings@1'), false)`,
    ),
    check('workspaces_status_check', sql`${table.status} IN ('active', 'archived')`),
    check('workspaces_version_check', sql`${table.version} > 0`),
    index('workspaces_tenant_version_idx')
      .on(table.tenantId, table.id, table.version)
      .where(sql`${table.deletedAt} IS NULL`),
    check(
      'workspaces_deleted_status_check',
      sql`${table.deletedAt} IS NULL OR ${table.status} = 'archived'`,
    ),
  ],
);

export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    scopeJson: jsonb('scope_json').$type<WorkspaceScope>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('workspace_memberships_workspace_user_uq').on(table.workspaceId, table.userId),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: 'workspace_memberships_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'workspace_memberships_user_fk',
    }).onDelete('cascade'),
    index('workspace_memberships_user_idx').on(table.userId, table.workspaceId),
    check(
      'workspace_memberships_scope_check',
      sql`COALESCE(jsonb_typeof(${table.scopeJson}) = 'object' AND (${table.scopeJson} = '{}'::jsonb OR ${table.scopeJson}->>'schema_version' = 'workspace-scope@1'), false)`,
    ),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    name: varchar({ length: 160 }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    objective: text(),
    status: varchar({ length: 16 }).$type<ProjectStatus>().notNull().default('active'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('projects_id_tenant_uq').on(table.id, table.tenantId),
    unique('projects_id_tenant_workspace_uq').on(table.id, table.tenantId, table.workspaceId),
    foreignKey({
      columns: [table.workspaceId, table.tenantId],
      foreignColumns: [workspaces.id, workspaces.tenantId],
      name: 'projects_workspace_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [users.id],
      name: 'projects_owner_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.ownerId],
      foreignColumns: [memberships.tenantId, memberships.userId],
      name: 'projects_owner_membership_fk',
    }).onDelete('restrict'),
    index('projects_workspace_status_idx')
      .on(table.tenantId, table.workspaceId, table.status, table.updatedAt.desc(), table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    index('projects_owner_status_idx')
      .on(table.tenantId, table.ownerId, table.status, table.updatedAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),
    check('projects_name_check', sql`char_length(btrim(${table.name})) BETWEEN 1 AND 160`),
    check(
      'projects_objective_check',
      sql`${table.objective} IS NULL OR char_length(btrim(${table.objective})) BETWEEN 1 AND 10000`,
    ),
    check('projects_status_check', sql`${table.status} IN ('active', 'archived')`),
    check(
      'projects_date_range_check',
      sql`${table.startDate} IS NULL OR ${table.endDate} IS NULL OR ${table.endDate} >= ${table.startDate}`,
    ),
    check(
      'projects_deleted_status_check',
      sql`${table.deletedAt} IS NULL OR ${table.status} = 'archived'`,
    ),
  ],
);

export const brandProfiles = pgTable(
  'brand_profiles',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    version: integer().notNull(),
    status: varchar({ length: 16 }).$type<BrandProfileStatus>().notNull().default('draft'),
    schemaVersion: varchar('schema_version', { length: 32 }).notNull(),
    profileJson: jsonb('profile_json').$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('brand_profiles_id_tenant_uq').on(table.id, table.tenantId),
    unique('brand_profiles_workspace_version_uq').on(
      table.tenantId,
      table.workspaceId,
      table.version,
    ),
    foreignKey({
      columns: [table.workspaceId, table.tenantId],
      foreignColumns: [workspaces.id, workspaces.tenantId],
      name: 'brand_profiles_workspace_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'brand_profiles_created_by_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.createdBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
      name: 'brand_profiles_created_by_membership_fk',
    }).onDelete('restrict'),
    uniqueIndex('brand_profiles_one_published_uq')
      .on(table.tenantId, table.workspaceId)
      .where(sql`${table.status} = 'published'`),
    index('brand_profiles_workspace_status_idx').on(
      table.tenantId,
      table.workspaceId,
      table.status,
      table.version.desc(),
    ),
    check('brand_profiles_version_check', sql`${table.version} > 0`),
    check('brand_profiles_status_check', sql`${table.status} IN ('draft', 'published', 'retired')`),
    check(
      'brand_profiles_schema_version_check',
      sql`char_length(btrim(${table.schemaVersion})) BETWEEN 1 AND 32`,
    ),
    check(
      'brand_profiles_profile_check',
      sql`COALESCE(jsonb_typeof(${table.profileJson}) = 'object', false)`,
    ),
    check(
      'brand_profiles_publication_check',
      sql`(${table.status} = 'draft' AND ${table.publishedAt} IS NULL) OR (${table.status} IN ('published', 'retired') AND ${table.publishedAt} IS NOT NULL)`,
    ),
  ],
);

export const keywordSets = pgTable(
  'keyword_sets',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: varchar({ length: 120 }).notNull(),
    status: varchar({ length: 16 }).$type<KeywordSetStatus>().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('keyword_sets_id_tenant_uq').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.projectId, table.tenantId],
      foreignColumns: [projects.id, projects.tenantId],
      name: 'keyword_sets_project_fk',
    }).onDelete('restrict'),
    uniqueIndex('keyword_sets_project_name_active_uq')
      .on(table.tenantId, table.projectId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index('keyword_sets_project_status_idx')
      .on(table.tenantId, table.projectId, table.status, table.updatedAt.desc(), table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    check('keyword_sets_name_check', sql`char_length(btrim(${table.name})) BETWEEN 1 AND 120`),
    check('keyword_sets_status_check', sql`${table.status} IN ('active', 'archived')`),
    check(
      'keyword_sets_deleted_status_check',
      sql`${table.deletedAt} IS NULL OR ${table.status} = 'archived'`,
    ),
  ],
);

export const keywords = pgTable(
  'keywords',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    keywordSetId: uuid('keyword_set_id').notNull(),
    term: citext().notNull(),
    intent: varchar({ length: 32 }).$type<KeywordIntent>().notNull(),
    priority: smallint().notNull().default(50),
    synonyms: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    platformScope: varchar('platform_scope', { length: 24 })
      .array()
      .$type<PlatformCode[]>()
      .notNull(),
    status: varchar({ length: 16 }).$type<KeywordStatus>().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('keywords_id_tenant_uq').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.keywordSetId, table.tenantId],
      foreignColumns: [keywordSets.id, keywordSets.tenantId],
      name: 'keywords_keyword_set_fk',
    }).onDelete('restrict'),
    unique('keywords_set_term_uq').on(table.tenantId, table.keywordSetId, table.term),
    index('keywords_set_status_priority_idx').on(
      table.tenantId,
      table.keywordSetId,
      table.status,
      table.priority.desc(),
      table.id,
    ),
    index('keywords_term_lookup_idx').on(table.tenantId, table.term),
    check('keywords_term_check', sql`char_length(btrim(${table.term}::text)) BETWEEN 1 AND 240`),
    check(
      'keywords_intent_check',
      sql`${table.intent} IN ('informational', 'commercial', 'transactional', 'navigational')`,
    ),
    check('keywords_priority_check', sql`${table.priority} BETWEEN 0 AND 100`),
    check('keywords_synonyms_check', sql`is_valid_nonblank_text_array(${table.synonyms})`),
    check(
      'keywords_platform_scope_check',
      sql`is_valid_platform_code_array(${table.platformScope})`,
    ),
    check('keywords_status_check', sql`${table.status} IN ('active', 'disabled')`),
  ],
);

export const generationRuns = pgTable(
  'generation_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id'),
    packageId: uuid('package_id'),
    variantId: uuid('variant_id'),
    skillName: varchar('skill_name', { length: 80 }).notNull(),
    skillVersion: varchar('skill_version', { length: 32 }).notNull(),
    promptVersionId: uuid('prompt_version_id').notNull(),
    modelKey: varchar('model_key', { length: 80 }).notNull(),
    status: varchar({ length: 16 }).$type<GenerationRunStatus>().notNull().default('queued'),
    inputHash: char('input_hash', { length: 64 }).notNull(),
    requestId: varchar('request_id', { length: 80 }).notNull(),
    errorJson: jsonb('error_json').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('generation_runs_id_tenant_uq').on(table.id, table.tenantId),
    unique('generation_runs_topic_scope_uq').on(
      table.id,
      table.tenantId,
      table.workspaceId,
      table.projectId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.tenantId],
      foreignColumns: [workspaces.id, workspaces.tenantId],
      name: 'generation_runs_workspace_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.projectId, table.tenantId, table.workspaceId],
      foreignColumns: [projects.id, projects.tenantId, projects.workspaceId],
      name: 'generation_runs_project_fk',
    }).onDelete('restrict'),
    index('generation_runs_request_idx').on(table.requestId, table.createdAt.desc()),
    index('generation_runs_scope_status_idx').on(
      table.tenantId,
      table.workspaceId,
      table.projectId,
      table.status,
      table.createdAt.desc(),
    ),
    check(
      'generation_runs_skill_name_check',
      sql`char_length(btrim(${table.skillName})) BETWEEN 1 AND 80`,
    ),
    check(
      'generation_runs_skill_version_check',
      sql`char_length(btrim(${table.skillVersion})) BETWEEN 1 AND 32 AND ${table.skillVersion} ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$'`,
    ),
    check(
      'generation_runs_model_key_check',
      sql`char_length(btrim(${table.modelKey})) BETWEEN 1 AND 80`,
    ),
    check(
      'generation_runs_status_check',
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check('generation_runs_input_hash_check', sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'generation_runs_request_id_check',
      sql`char_length(btrim(${table.requestId})) BETWEEN 1 AND 80`,
    ),
    check(
      'generation_runs_error_check',
      sql`${table.errorJson} IS NULL OR jsonb_typeof(${table.errorJson}) = 'object'`,
    ),
    check(
      'generation_runs_time_check',
      sql`(${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt}) AND (${table.finishedAt} IS NULL OR ${table.startedAt} IS NOT NULL) AND (${table.finishedAt} IS NULL OR ${table.finishedAt} >= ${table.startedAt})`,
    ),
  ],
);

export const topicCandidates = pgTable(
  'topic_candidates',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    generationRunId: uuid('generation_run_id').notNull(),
    question: text().notNull(),
    intent: varchar({ length: 32 }).notNull(),
    entitiesJson: jsonb('entities_json').$type<EntityList>().notNull(),
    evidenceSummaryJson: jsonb('evidence_summary_json').$type<CitationSet>().notNull(),
    platformCodes: varchar('platform_codes', { length: 24 })
      .array()
      .$type<PlatformCode[]>()
      .notNull(),
    priority: smallint().notNull(),
    riskLevel: varchar('risk_level', { length: 16 }).$type<TopicRiskLevel>().notNull(),
    status: varchar({ length: 16 }).$type<TopicCandidateStatus>().notNull().default('proposed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('topic_candidates_id_tenant_uq').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.workspaceId, table.tenantId],
      foreignColumns: [workspaces.id, workspaces.tenantId],
      name: 'topic_candidates_workspace_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.projectId, table.tenantId, table.workspaceId],
      foreignColumns: [projects.id, projects.tenantId, projects.workspaceId],
      name: 'topic_candidates_project_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.generationRunId, table.tenantId, table.workspaceId, table.projectId],
      foreignColumns: [
        generationRuns.id,
        generationRuns.tenantId,
        generationRuns.workspaceId,
        generationRuns.projectId,
      ],
      name: 'topic_candidates_generation_run_fk',
    }).onDelete('restrict'),
    index('topic_candidates_scope_status_idx').on(
      table.tenantId,
      table.workspaceId,
      table.projectId,
      table.status,
      table.priority.desc(),
      table.createdAt.desc(),
      table.id,
    ),
    index('topic_candidates_run_idx').on(
      table.tenantId,
      table.generationRunId,
      table.createdAt,
      table.id,
    ),
    check(
      'topic_candidates_question_check',
      sql`char_length(btrim(${table.question})) BETWEEN 5 AND 2000`,
    ),
    check(
      'topic_candidates_intent_check',
      sql`char_length(btrim(${table.intent})) BETWEEN 1 AND 32`,
    ),
    check(
      'topic_candidates_entities_check',
      sql`COALESCE(jsonb_typeof(${table.entitiesJson}) = 'object' AND ${table.entitiesJson}->>'schema_version' = 'entity-list@1' AND jsonb_typeof(${table.entitiesJson}->'entities') = 'array' AND jsonb_array_length(${table.entitiesJson}->'entities') > 0 AND NOT jsonb_path_exists(${table.entitiesJson}, '$.entities[*] ? (@.type() != "string" || @ == "")'), false)`,
    ),
    check(
      'topic_candidates_evidence_check',
      sql`COALESCE(jsonb_typeof(${table.evidenceSummaryJson}) = 'object' AND ${table.evidenceSummaryJson}->>'schema_version' = 'citation-set@1' AND jsonb_typeof(${table.evidenceSummaryJson}->'evidence_ids') = 'array', false)`,
    ),
    check(
      'topic_candidates_platform_codes_check',
      sql`is_valid_platform_code_array(${table.platformCodes})`,
    ),
    check('topic_candidates_priority_check', sql`${table.priority} BETWEEN 0 AND 100`),
    check(
      'topic_candidates_risk_check',
      sql`${table.riskLevel} IN ('low', 'medium', 'high', 'critical')`,
    ),
    check(
      'topic_candidates_status_check',
      sql`${table.status} IN ('proposed', 'adopted', 'archived')`,
    ),
  ],
);

export type WorkspaceRecord = typeof workspaces.$inferSelect;
export type WorkspaceMembershipRecord = typeof workspaceMemberships.$inferSelect;
export type ProjectRecord = typeof projects.$inferSelect;
export type BrandProfileRecord = typeof brandProfiles.$inferSelect;
export type KeywordSetRecord = typeof keywordSets.$inferSelect;
export type KeywordRecord = typeof keywords.$inferSelect;
export type GenerationRunRecord = typeof generationRuns.$inferSelect;
export type TopicCandidateRecord = typeof topicCandidates.$inferSelect;
