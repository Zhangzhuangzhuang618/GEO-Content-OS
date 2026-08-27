import { sql } from 'drizzle-orm';
import type {
  QualityDecision,
  QualityGeoScores,
  QualityIssue,
} from '@geo-content-os/contracts/skills';
import {
  char,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { contentVariants, contentVersions } from './content.js';
import { tenants } from './identity.js';
import { facts, sourceChunks } from './knowledge.js';
import { generationRuns } from './workspace.js';

export type FactCheckVerdict =
  'supported' | 'partially_supported' | 'conflicted' | 'unsupported' | 'outdated';
export type FactCheckRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type FactEvidenceSupportLevel = Exclude<FactCheckVerdict, 'unsupported'>;

export interface QualityIssuesDocument {
  readonly issues: readonly QualityIssue[];
  readonly schema_version: 'quality-checker-data@1';
}

export interface QualityGeoScoresDocument extends QualityGeoScores {
  readonly schema_version: 'geo-scores@1';
}

export interface AutomationGateDocument {
  readonly blocking_rules: readonly string[];
  readonly brand_consistency: number;
  readonly factual_accuracy: number;
  readonly geo_total: number;
  readonly passed: boolean;
  readonly platform_fit: number;
  readonly platform_code?: 'douyin' | 'lieju' | 'sohu';
  readonly question_coverage: number;
  readonly readability_safety: number;
  readonly schema_version:
    'baijiahao-quality-gate@1' | 'browser-platform-quality-gate@1' | 'official-site-quality-gate@1';
}

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

export const qualityReports = pgTable(
  'quality_reports',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    contentVersionId: uuid('content_version_id').notNull(),
    generationRunId: uuid('generation_run_id').notNull(),
    checkerVersion: varchar('checker_version', { length: 32 }).notNull(),
    score: numeric({ precision: 5, scale: 2 }).notNull(),
    decision: varchar({ length: 16 }).$type<QualityDecision>().notNull(),
    issuesJson: jsonb('issues_json').$type<QualityIssuesDocument>().notNull(),
    geoScoresJson: jsonb('geo_scores_json').$type<QualityGeoScoresDocument>().notNull(),
    automationGateJson: jsonb('automation_gate_json').$type<AutomationGateDocument>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('quality_reports_id_tenant_uq').on(table.id, table.tenantId),
    unique('quality_reports_run_uq').on(table.tenantId, table.generationRunId),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: 'quality_reports_tenant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.variantId, table.tenantId],
      foreignColumns: [contentVariants.id, contentVariants.tenantId],
      name: 'quality_reports_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.contentVersionId, table.tenantId],
      foreignColumns: [contentVersions.id, contentVersions.tenantId],
      name: 'quality_reports_content_version_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.generationRunId, table.tenantId],
      foreignColumns: [generationRuns.id, generationRuns.tenantId],
      name: 'quality_reports_generation_run_fk',
    }).onDelete('restrict'),
    index('quality_reports_variant_created_idx').on(
      table.tenantId,
      table.variantId,
      table.createdAt.desc(),
      table.id,
    ),
    check(
      'quality_reports_checker_version_check',
      sql`char_length(btrim(${table.checkerVersion})) BETWEEN 1 AND 32 AND ${table.checkerVersion} ~ '^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$'`,
    ),
    check('quality_reports_score_check', sql`${table.score} BETWEEN 0 AND 100`),
    check('quality_reports_decision_check', sql`${table.decision} IN ('pass', 'revise', 'block')`),
  ],
);

export type FactCheckResultRecord = typeof factCheckResults.$inferSelect;
export type FactEvidenceRecord = typeof factEvidences.$inferSelect;
export type QualityReportRecord = typeof qualityReports.$inferSelect;
