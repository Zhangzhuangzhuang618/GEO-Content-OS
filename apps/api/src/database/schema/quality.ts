import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { contentVariants } from './content.js';
import { tenants } from './identity.js';
import { facts, sourceChunks } from './knowledge.js';
import { generationRuns } from './workspace.js';

export type FactCheckVerdict =
  'supported' | 'partially_supported' | 'conflicted' | 'unsupported' | 'outdated';
export type FactCheckRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type FactEvidenceSupportLevel = Exclude<FactCheckVerdict, 'unsupported'>;

export const factCheckResults = pgTable(
  'fact_check_results',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    generationRunId: uuid('generation_run_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    factId: uuid('fact_id'),
    claimKey: varchar('claim_key', { length: 80 }).notNull(),
    claimText: text('claim_text').notNull(),
    claimHash: char('claim_hash', { length: 64 }).notNull(),
    verdict: varchar({ length: 24 }).$type<FactCheckVerdict>().notNull(),
    riskLevel: varchar('risk_level', { length: 16 }).$type<FactCheckRiskLevel>().notNull(),
    confidence: numeric({ precision: 5, scale: 4 }).notNull(),
    reason: text().notNull(),
    rewriteSuggestion: text('rewrite_suggestion'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('fact_check_results_id_tenant_uq').on(table.id, table.tenantId),
    unique('fact_check_results_run_claim_uq').on(
      table.tenantId,
      table.generationRunId,
      table.variantId,
      table.claimHash,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: 'fact_check_results_tenant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.generationRunId, table.tenantId],
      foreignColumns: [generationRuns.id, generationRuns.tenantId],
      name: 'fact_check_results_run_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.variantId, table.tenantId],
      foreignColumns: [contentVariants.id, contentVariants.tenantId],
      name: 'fact_check_results_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.factId, table.tenantId],
      foreignColumns: [facts.id, facts.tenantId],
      name: 'fact_check_results_fact_fk',
    }).onDelete('restrict'),
    index('fact_check_results_variant_created_idx').on(
      table.tenantId,
      table.variantId,
      table.createdAt.desc(),
      table.id,
    ),
    check(
      'fact_check_results_claim_key_check',
      sql`char_length(btrim(${table.claimKey})) BETWEEN 1 AND 80`,
    ),
    check(
      'fact_check_results_claim_text_check',
      sql`char_length(btrim(${table.claimText})) BETWEEN 1 AND 10000`,
    ),
    check('fact_check_results_claim_hash_check', sql`${table.claimHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'fact_check_results_verdict_check',
      sql`${table.verdict} IN ('supported', 'partially_supported', 'conflicted', 'unsupported', 'outdated')`,
    ),
    check(
      'fact_check_results_risk_level_check',
      sql`${table.riskLevel} IN ('low', 'medium', 'high', 'critical')`,
    ),
    check('fact_check_results_confidence_check', sql`${table.confidence} BETWEEN 0 AND 1`),
  ],
);

export const factEvidences = pgTable(
  'fact_evidences',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    factCheckResultId: uuid('fact_check_result_id').notNull(),
    factId: uuid('fact_id'),
    chunkId: uuid('chunk_id').notNull(),
    quoteText: text('quote_text').notNull(),
    quoteHash: char('quote_hash', { length: 64 }).notNull(),
    supportLevel: varchar('support_level', { length: 24 })
      .$type<FactEvidenceSupportLevel>()
      .notNull(),
    confidence: numeric({ precision: 5, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('fact_evidences_id_tenant_uq').on(table.id, table.tenantId),
    unique('fact_evidences_result_chunk_quote_uq').on(
      table.tenantId,
      table.factCheckResultId,
      table.chunkId,
      table.quoteHash,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: 'fact_evidences_tenant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.factCheckResultId, table.tenantId],
      foreignColumns: [factCheckResults.id, factCheckResults.tenantId],
      name: 'fact_evidences_result_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.factId, table.tenantId],
      foreignColumns: [facts.id, facts.tenantId],
      name: 'fact_evidences_fact_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.chunkId, table.tenantId],
      foreignColumns: [sourceChunks.id, sourceChunks.tenantId],
      name: 'fact_evidences_chunk_fk',
    }).onDelete('restrict'),
    index('fact_evidences_chunk_idx').on(table.tenantId, table.chunkId, table.factCheckResultId),
    check(
      'fact_evidences_quote_text_check',
      sql`char_length(btrim(${table.quoteText})) BETWEEN 1 AND 10000`,
    ),
    check('fact_evidences_quote_hash_check', sql`${table.quoteHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'fact_evidences_support_level_check',
      sql`${table.supportLevel} IN ('supported', 'partially_supported', 'conflicted', 'outdated')`,
    ),
    check('fact_evidences_confidence_check', sql`${table.confidence} BETWEEN 0 AND 1`),
  ],
);

export type FactCheckResultRecord = typeof factCheckResults.$inferSelect;
export type FactEvidenceRecord = typeof factEvidences.$inferSelect;
