import { sql } from 'drizzle-orm';
import {
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
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
import { projects, workspaces } from './workspace.js';

const searchVector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const vector1536 = customType<{ data: readonly number[]; driverData: string }>({
  dataType: () => 'vector(1536)',
  fromDriver: (value) =>
    value
      .slice(1, -1)
      .split(',')
      .map((item) => Number(item)),
  toDriver: (value) => `[${value.join(',')}]`,
});

export type SourceType = 'pdf' | 'url' | 'docx' | 'txt' | 'image';
export type SourceTrustLevel = 'verified' | 'normal' | 'untrusted';
export type SourceDocumentStatus = 'processing' | 'active' | 'expired' | 'failed';
export type IngestJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type IngestStage =
  'queued' | 'upload' | 'scan' | 'parse' | 'chunk' | 'embed' | 'index' | 'done';
export type SourceChunkStatus = 'active' | 'inactive';
export type FactStatus = 'candidate' | 'verified' | 'conflicted' | 'retired';

export interface IngestJobError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly schema_version: 'job-error@1';
  readonly [key: string]: unknown;
}

export interface ChunkMetadata {
  readonly char_end?: number;
  readonly char_start?: number;
  readonly headings?: readonly string[];
  readonly page?: number;
  readonly schema_version: 'chunk-metadata@1';
  readonly url?: string;
}

export interface CertificateSourceMetadata {
  readonly article_use_allowed: boolean;
  readonly certificate_name: string;
  readonly certificate_number: string;
  readonly holder_name: string;
  readonly issuing_authority: string;
  readonly public_display_confirmed: boolean;
  readonly schema_version: 'source-certificate@1';
  readonly verification_url: string | null;
}

export type SourceDocumentMetadata = CertificateSourceMetadata | Readonly<Record<string, never>>;

export const sourceDocuments = pgTable(
  'source_documents',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id'),
    title: varchar({ length: 240 }).notNull(),
    sourceType: varchar('source_type', { length: 24 }).$type<SourceType>().notNull(),
    mimeType: varchar('mime_type', { length: 120 }).notNull(),
    language: varchar({ length: 16 }).notNull().default('zh-CN'),
    uri: text().notNull(),
    contentHash: char('content_hash', { length: 64 }).notNull(),
    trustLevel: varchar('trust_level', { length: 16 })
      .$type<SourceTrustLevel>()
      .notNull()
      .default('normal'),
    effectiveFrom: date('effective_from', { mode: 'string' }),
    effectiveTo: date('effective_to', { mode: 'string' }),
    metadataJson: jsonb('metadata_json')
      .$type<SourceDocumentMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: varchar({ length: 16 }).$type<SourceDocumentStatus>().notNull().default('processing'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('source_documents_id_tenant_uq').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: 'source_documents_tenant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.tenantId],
      foreignColumns: [workspaces.id, workspaces.tenantId],
      name: 'source_documents_workspace_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.projectId, table.tenantId, table.workspaceId],
      foreignColumns: [projects.id, projects.tenantId, projects.workspaceId],
      name: 'source_documents_project_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'source_documents_created_by_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.createdBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
      name: 'source_documents_created_by_membership_fk',
    }).onDelete('restrict'),
    uniqueIndex('uq_source_hash_active')
      .on(table.tenantId, table.workspaceId, table.contentHash)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex('uq_source_url_active')
      .on(table.tenantId, table.workspaceId, table.uri)
      .where(sql`${table.deletedAt} IS NULL AND ${table.sourceType} = 'url'`),
    index('source_documents_scope_status_idx')
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
      'source_documents_title_check',
      sql`char_length(btrim(${table.title})) BETWEEN 1 AND 240`,
    ),
    check(
      'source_documents_type_mime_check',
      sql`(${table.sourceType} = 'pdf' AND ${table.mimeType} = 'application/pdf')
        OR (${table.sourceType} = 'docx' AND ${table.mimeType} = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        OR (${table.sourceType} = 'txt' AND ${table.mimeType} = 'text/plain')
        OR (${table.sourceType} = 'url' AND ${table.mimeType} IN ('text/html', 'application/xhtml+xml'))
        OR (${table.sourceType} = 'image' AND ${table.mimeType} IN ('image/png', 'image/jpeg', 'image/webp'))`,
    ),
    check(
      'source_documents_language_check',
      sql`${table.language} ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`,
    ),
    check('source_documents_uri_check', sql`char_length(btrim(${table.uri})) BETWEEN 1 AND 8192`),
    check('source_documents_content_hash_check', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'source_documents_trust_level_check',
      sql`${table.trustLevel} IN ('verified', 'normal', 'untrusted')`,
    ),
    check(
      'source_documents_status_check',
      sql`${table.status} IN ('processing', 'active', 'expired', 'failed')`,
    ),
    check(
      'source_documents_effective_range_check',
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveFrom} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    check(
      'source_documents_metadata_object_check',
      sql`jsonb_typeof(${table.metadataJson}) = 'object'`,
    ),
    check(
      'source_documents_metadata_schema_check',
      sql`${table.metadataJson} = '{}'::jsonb OR COALESCE(
        ${table.sourceType} = 'image'
        AND ${table.metadataJson}->>'schema_version' = 'source-certificate@1'
        AND (${table.metadataJson} - ARRAY[
          'schema_version', 'certificate_name', 'certificate_number', 'holder_name',
          'issuing_authority', 'verification_url', 'article_use_allowed',
          'public_display_confirmed'
        ]::text[]) = '{}'::jsonb
        AND char_length(btrim(${table.metadataJson}->>'certificate_name')) BETWEEN 1 AND 240
        AND char_length(btrim(${table.metadataJson}->>'certificate_number')) BETWEEN 1 AND 120
        AND char_length(btrim(${table.metadataJson}->>'holder_name')) BETWEEN 1 AND 240
        AND char_length(btrim(${table.metadataJson}->>'issuing_authority')) BETWEEN 1 AND 240
        AND jsonb_typeof(${table.metadataJson}->'article_use_allowed') = 'boolean'
        AND jsonb_typeof(${table.metadataJson}->'public_display_confirmed') = 'boolean'
        AND (
          ${table.metadataJson}->'verification_url' = 'null'::jsonb
          OR (
            jsonb_typeof(${table.metadataJson}->'verification_url') = 'string'
            AND char_length(${table.metadataJson}->>'verification_url') BETWEEN 1 AND 2048
            AND ${table.metadataJson}->>'verification_url' ~ '^https://'
          )
        )
        AND (
          (${table.metadataJson}->>'article_use_allowed')::boolean IS NOT TRUE
          OR (${table.metadataJson}->>'public_display_confirmed')::boolean IS TRUE
        ),
        false
      )`,
    ),
    check(
      'source_documents_deleted_status_check',
      sql`${table.deletedAt} IS NULL OR ${table.status} IN ('expired', 'failed')`,
    ),
  ],
);

export const ingestJobs = pgTable(
  'ingest_jobs',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    sourceDocumentId: uuid('source_document_id').notNull(),
    status: varchar({ length: 16 }).$type<IngestJobStatus>().notNull().default('queued'),
    attemptCount: smallint('attempt_count').notNull().default(0),
    stage: varchar({ length: 24 }).$type<IngestStage>().notNull().default('queued'),
    progress: smallint().notNull().default(0),
    errorJson: jsonb('error_json').$type<IngestJobError>(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('ingest_jobs_id_tenant_uq').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.sourceDocumentId, table.tenantId],
      foreignColumns: [sourceDocuments.id, sourceDocuments.tenantId],
      name: 'ingest_jobs_source_fk',
    }).onDelete('cascade'),
    index('ingest_jobs_source_created_idx').on(
      table.tenantId,
      table.sourceDocumentId,
      table.createdAt.desc(),
      table.id,
    ),
    index('ingest_jobs_pending_idx')
      .on(table.createdAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    check(
      'ingest_jobs_status_check',
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check('ingest_jobs_attempt_count_check', sql`${table.attemptCount} >= 0`),
    check(
      'ingest_jobs_stage_check',
      sql`${table.stage} IN ('queued', 'upload', 'scan', 'parse', 'chunk', 'embed', 'index', 'done')`,
    ),
    check('ingest_jobs_progress_check', sql`${table.progress} BETWEEN 0 AND 100`),
    check(
      'ingest_jobs_error_check',
      sql`${table.errorJson} IS NULL OR COALESCE(
        jsonb_typeof(${table.errorJson}) = 'object'
        AND ${table.errorJson}->>'schema_version' = 'job-error@1'
        AND char_length(btrim(${table.errorJson}->>'code')) BETWEEN 1 AND 80
        AND char_length(btrim(${table.errorJson}->>'message')) BETWEEN 1 AND 2000,
        false
      )`,
    ),
    check(
      'ingest_jobs_temporal_check',
      sql`${table.finishedAt} IS NULL OR (${table.startedAt} IS NOT NULL AND ${table.finishedAt} >= ${table.startedAt})`,
    ),
    check(
      'ingest_jobs_terminal_check',
      sql`(${table.status} = 'queued' AND ${table.startedAt} IS NULL AND ${table.finishedAt} IS NULL)
        OR (${table.status} = 'running' AND ${table.startedAt} IS NOT NULL AND ${table.finishedAt} IS NULL)
        OR (${table.status} = 'succeeded' AND ${table.startedAt} IS NOT NULL AND ${table.finishedAt} IS NOT NULL AND ${table.stage} = 'done' AND ${table.progress} = 100 AND ${table.errorJson} IS NULL)
        OR (${table.status} = 'failed' AND ${table.startedAt} IS NOT NULL AND ${table.finishedAt} IS NOT NULL AND ${table.errorJson} IS NOT NULL)
        OR (${table.status} = 'cancelled' AND ${table.finishedAt} IS NOT NULL)`,
    ),
  ],
);

export const sourceChunks = pgTable(
  'source_chunks',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    sourceDocumentId: uuid('source_document_id').notNull(),
    chunkNo: integer('chunk_no').notNull(),
    text: text().notNull(),
    textHash: char('text_hash', { length: 64 }).notNull(),
    metadataJson: jsonb('metadata_json').$type<ChunkMetadata>().notNull(),
    tokenCount: integer('token_count').notNull(),
    searchVector: searchVector('search_vector').generatedAlwaysAs(sql`to_tsvector('simple', text)`),
    status: varchar({ length: 16 }).$type<SourceChunkStatus>().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('source_chunks_id_tenant_uq').on(table.id, table.tenantId),
    unique('source_chunks_source_chunk_uq').on(
      table.tenantId,
      table.sourceDocumentId,
      table.chunkNo,
    ),
    foreignKey({
      columns: [table.sourceDocumentId, table.tenantId],
      foreignColumns: [sourceDocuments.id, sourceDocuments.tenantId],
      name: 'source_chunks_source_fk',
    }).onDelete('cascade'),
    index('source_chunks_source_status_idx').on(
      table.tenantId,
      table.sourceDocumentId,
      table.status,
      table.chunkNo,
      table.id,
    ),
    index('source_chunks_search_vector_idx').using('gin', table.searchVector),
    check('source_chunks_chunk_no_check', sql`${table.chunkNo} >= 0`),
    check('source_chunks_text_check', sql`char_length(btrim(${table.text})) > 0`),
    check('source_chunks_text_hash_check', sql`${table.textHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'source_chunks_metadata_check',
      sql`COALESCE(
        jsonb_typeof(${table.metadataJson}) = 'object'
        AND ${table.metadataJson}->>'schema_version' = 'chunk-metadata@1'
        AND ${table.metadataJson} - ARRAY['schema_version', 'page', 'url', 'char_start', 'char_end', 'headings']::text[] = '{}'::jsonb
        AND (NOT ${table.metadataJson} ? 'page' OR (jsonb_typeof(${table.metadataJson}->'page') = 'number' AND (${table.metadataJson}->>'page')::numeric = trunc((${table.metadataJson}->>'page')::numeric) AND (${table.metadataJson}->>'page')::numeric > 0))
        AND (NOT ${table.metadataJson} ? 'url' OR (jsonb_typeof(${table.metadataJson}->'url') = 'string' AND char_length(btrim(${table.metadataJson}->>'url')) BETWEEN 1 AND 8192))
        AND (NOT ${table.metadataJson} ? 'char_start' OR (jsonb_typeof(${table.metadataJson}->'char_start') = 'number' AND (${table.metadataJson}->>'char_start')::numeric = trunc((${table.metadataJson}->>'char_start')::numeric) AND (${table.metadataJson}->>'char_start')::numeric >= 0))
        AND (NOT ${table.metadataJson} ? 'char_end' OR (jsonb_typeof(${table.metadataJson}->'char_end') = 'number' AND (${table.metadataJson}->>'char_end')::numeric = trunc((${table.metadataJson}->>'char_end')::numeric) AND (${table.metadataJson}->>'char_end')::numeric >= 0))
        AND (NOT (${table.metadataJson} ? 'char_start' AND ${table.metadataJson} ? 'char_end') OR (${table.metadataJson}->>'char_end')::numeric >= (${table.metadataJson}->>'char_start')::numeric)
        AND (NOT ${table.metadataJson} ? 'headings' OR is_valid_nonblank_jsonb_string_array(${table.metadataJson}->'headings', 0, 32)),
        false
      )`,
    ),
    check('source_chunks_token_count_check', sql`${table.tokenCount} > 0`),
    check('source_chunks_token_count_max_check', sql`${table.tokenCount} <= 900`),
    check(
      'source_chunks_locator_required_check',
      sql`${table.metadataJson} ?& ARRAY['char_start', 'char_end']::text[]
        AND (${table.metadataJson}->>'char_end')::numeric > (${table.metadataJson}->>'char_start')::numeric`,
    ),
    check('source_chunks_status_check', sql`${table.status} IN ('active', 'inactive')`),
  ],
);

export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    chunkId: uuid('chunk_id').notNull(),
    modelKey: varchar('model_key', { length: 80 }).notNull(),
    dimension: smallint().notNull().default(1536),
    embedding: vector1536().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('embeddings_chunk_model_uq').on(table.tenantId, table.chunkId, table.modelKey),
    foreignKey({
      columns: [table.chunkId, table.tenantId],
      foreignColumns: [sourceChunks.id, sourceChunks.tenantId],
      name: 'embeddings_chunk_fk',
    }).onDelete('cascade'),
    index('embeddings_vector_hnsw_idx').using(
      'hnsw',
      table.embedding.asc().op('vector_cosine_ops'),
    ),
    index('embeddings_tenant_model_idx').on(table.tenantId, table.modelKey, table.chunkId),
    check(
      'embeddings_model_key_check',
      sql`char_length(btrim(${table.modelKey})) BETWEEN 1 AND 80`,
    ),
    check('embeddings_dimension_check', sql`${table.dimension} = 1536`),
  ],
);

export const facts = pgTable(
  'facts',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    subject: varchar({ length: 240 }).notNull(),
    predicate: varchar({ length: 120 }).notNull(),
    objectValue: text('object_value').notNull(),
    unit: varchar({ length: 32 }),
    validFrom: date('valid_from', { mode: 'string' }),
    validTo: date('valid_to', { mode: 'string' }),
    confidence: numeric({ precision: 5, scale: 4 }).notNull(),
    status: varchar({ length: 16 }).$type<FactStatus>().notNull().default('candidate'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('facts_id_tenant_uq').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.workspaceId, table.tenantId],
      foreignColumns: [workspaces.id, workspaces.tenantId],
      name: 'facts_workspace_fk',
    }).onDelete('restrict'),
    index('facts_subject_predicate_status_idx').on(
      table.tenantId,
      table.workspaceId,
      table.subject,
      table.predicate,
      table.status,
    ),
    check('facts_subject_check', sql`char_length(btrim(${table.subject})) BETWEEN 1 AND 240`),
    check('facts_predicate_check', sql`char_length(btrim(${table.predicate})) BETWEEN 1 AND 120`),
    check('facts_object_value_check', sql`char_length(btrim(${table.objectValue})) > 0`),
    check(
      'facts_unit_check',
      sql`${table.unit} IS NULL OR char_length(btrim(${table.unit})) BETWEEN 1 AND 32`,
    ),
    check(
      'facts_valid_range_check',
      sql`${table.validTo} IS NULL OR ${table.validFrom} IS NULL OR ${table.validTo} >= ${table.validFrom}`,
    ),
    check('facts_confidence_check', sql`${table.confidence} BETWEEN 0 AND 1`),
    check(
      'facts_status_check',
      sql`${table.status} IN ('candidate', 'verified', 'conflicted', 'retired')`,
    ),
  ],
);

export const factSources = pgTable(
  'fact_sources',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    factId: uuid('fact_id').notNull(),
    chunkId: uuid('chunk_id').notNull(),
    quoteText: text('quote_text').notNull(),
    quoteHash: char('quote_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('fact_sources_fact_chunk_quote_uq').on(
      table.tenantId,
      table.factId,
      table.chunkId,
      table.quoteHash,
    ),
    foreignKey({
      columns: [table.factId, table.tenantId],
      foreignColumns: [facts.id, facts.tenantId],
      name: 'fact_sources_fact_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.chunkId, table.tenantId],
      foreignColumns: [sourceChunks.id, sourceChunks.tenantId],
      name: 'fact_sources_chunk_fk',
    }).onDelete('restrict'),
    index('fact_sources_chunk_idx').on(table.tenantId, table.chunkId, table.factId),
    check('fact_sources_quote_text_check', sql`char_length(btrim(${table.quoteText})) > 0`),
    check('fact_sources_quote_hash_check', sql`${table.quoteHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type SourceDocumentRecord = typeof sourceDocuments.$inferSelect;
export type IngestJobRecord = typeof ingestJobs.$inferSelect;
export type SourceChunkRecord = typeof sourceChunks.$inferSelect;
export type EmbeddingRecord = typeof embeddings.$inferSelect;
export type FactRecord = typeof facts.$inferSelect;
export type FactSourceRecord = typeof factSources.$inferSelect;
