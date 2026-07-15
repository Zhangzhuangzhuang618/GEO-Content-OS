import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';
import { FactCheckError } from './fact-check.errors.js';
import type {
  FactCheckResultView,
  FactCheckScope,
  FactEvidenceView,
  PreparedFactCheckResult,
} from './fact-check.types.js';

type SqlClient = DatabaseClient | TransactionSql;

interface ResultRow extends Omit<FactCheckResultView, 'confidence' | 'evidences'> {
  readonly confidence: string;
}

interface EvidenceRow extends Omit<FactEvidenceView, 'confidence'> {
  readonly confidence: string;
  readonly factCheckResultId: string;
}

export class FactCheckRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async findByClaimHashes(
    scope: FactCheckScope,
    claimHashes: readonly string[],
  ): Promise<readonly FactCheckResultView[]> {
    if (claimHashes.length === 0) return Object.freeze([]);
    return selectResults(this.client, scope, claimHashes);
  }

  public async persist(
    scope: FactCheckScope,
    results: readonly PreparedFactCheckResult[],
    allClaimHashes: readonly string[],
  ): Promise<readonly FactCheckResultView[]> {
    return this.client.begin(async (transaction) => {
      const locked = await transaction<{ id: string }[]>`
        SELECT run.id
        FROM generation_runs AS run
        JOIN content_variants AS variant
          ON variant.id = run.variant_id
          AND variant.tenant_id = run.tenant_id
          AND variant.package_id = run.package_id
        JOIN content_packages AS package
          ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
        WHERE
          run.id = ${scope.generationRunId}::uuid
          AND run.tenant_id = ${scope.tenantId}::uuid
          AND run.workspace_id = ${scope.workspaceId}::uuid
          AND run.project_id = ${scope.projectId}::uuid
          AND run.variant_id = ${scope.variantId}::uuid
          AND run.skill_name = 'fact-checker'
          AND package.workspace_id = ${scope.workspaceId}::uuid
          AND package.project_id = ${scope.projectId}::uuid
        FOR UPDATE OF run
      `;
      if (locked.length !== 1) {
        throw new FactCheckError(
          'FACT_CHECK_SCOPE_NOT_FOUND',
          'Fact-check generation run was not found in the requested scope',
        );
      }

      const existing = new Set(
        (await selectResults(transaction, scope, allClaimHashes)).map((result) => result.claimHash),
      );
      for (const result of results) {
        if (existing.has(result.claim.claimHash)) continue;
        const inserted = await transaction<{ id: string }[]>`
          INSERT INTO fact_check_results (
            tenant_id, generation_run_id, variant_id, fact_id,
            claim_key, claim_text, claim_hash, verdict, risk_level,
            confidence, reason, rewrite_suggestion
          ) VALUES (
            ${scope.tenantId}::uuid,
            ${scope.generationRunId}::uuid,
            ${scope.variantId}::uuid,
            ${result.factId}::uuid,
            ${result.claim.claimKey},
            ${result.claim.claimText},
            ${result.claim.claimHash},
            ${result.verdict},
            ${result.claim.riskLevel},
            ${result.confidence},
            ${result.reason},
            ${result.rewriteSuggestion}
          )
          ON CONFLICT (tenant_id, generation_run_id, variant_id, claim_hash) DO NOTHING
          RETURNING id
        `;
        const resultId = inserted[0]?.id;
        if (!resultId) continue;
        for (const evidence of result.evidences) {
          await transaction`
            INSERT INTO fact_evidences (
              tenant_id, fact_check_result_id, fact_id, chunk_id,
              quote_text, quote_hash, support_level, confidence
            ) VALUES (
              ${scope.tenantId}::uuid,
              ${resultId}::uuid,
              ${evidence.factId}::uuid,
              ${evidence.chunkId}::uuid,
              ${evidence.quoteText},
              ${evidence.quoteHash},
              ${evidence.supportLevel},
              ${evidence.confidence}
            )
          `;
        }
        existing.add(result.claim.claimHash);
      }
      return selectResults(transaction, scope, allClaimHashes);
    });
  }
}

async function selectResults(
  client: SqlClient,
  scope: FactCheckScope,
  claimHashes: readonly string[],
): Promise<readonly FactCheckResultView[]> {
  if (claimHashes.length === 0) return Object.freeze([]);
  const rows = await client<ResultRow[]>`
    SELECT
      result.id,
      result.tenant_id AS "tenantId",
      result.generation_run_id AS "generationRunId",
      result.variant_id AS "variantId",
      result.fact_id AS "factId",
      result.claim_key AS "claimKey",
      result.claim_text AS "claimText",
      result.claim_hash AS "claimHash",
      result.verdict,
      result.risk_level AS "riskLevel",
      result.confidence::text AS confidence,
      result.reason,
      result.rewrite_suggestion AS "rewriteSuggestion",
      result.created_at AS "createdAt"
    FROM fact_check_results AS result
    WHERE
      result.tenant_id = ${scope.tenantId}::uuid
      AND result.generation_run_id = ${scope.generationRunId}::uuid
      AND result.variant_id = ${scope.variantId}::uuid
      AND result.claim_hash = ANY(${client.array([...claimHashes])}::char(64)[])
  `;
  if (rows.length === 0) return Object.freeze([]);
  const resultIds = rows.map((row) => row.id);
  const evidenceRows = await client<EvidenceRow[]>`
    SELECT
      evidence.id,
      evidence.tenant_id AS "tenantId",
      evidence.fact_check_result_id AS "factCheckResultId",
      evidence.fact_id AS "factId",
      evidence.chunk_id AS "chunkId",
      evidence.quote_text AS "quoteText",
      evidence.quote_hash AS "quoteHash",
      evidence.support_level AS "supportLevel",
      evidence.confidence::text AS confidence,
      evidence.created_at AS "createdAt"
    FROM fact_evidences AS evidence
    WHERE
      evidence.tenant_id = ${scope.tenantId}::uuid
      AND evidence.fact_check_result_id = ANY(${client.array(resultIds)}::uuid[])
    ORDER BY evidence.created_at, evidence.id
  `;
  const evidenceByResult = new Map<string, FactEvidenceView[]>();
  for (const row of evidenceRows) {
    const evidences = evidenceByResult.get(row.factCheckResultId) ?? [];
    evidences.push(
      Object.freeze({
        chunkId: row.chunkId,
        confidence: Number(row.confidence),
        createdAt: row.createdAt,
        factId: row.factId,
        id: row.id,
        quoteHash: row.quoteHash,
        quoteText: row.quoteText,
        supportLevel: row.supportLevel,
        tenantId: row.tenantId,
      }),
    );
    evidenceByResult.set(row.factCheckResultId, evidences);
  }
  const byHash = new Map(
    rows.map((row) => [
      row.claimHash,
      Object.freeze({
        ...row,
        confidence: Number(row.confidence),
        evidences: Object.freeze(evidenceByResult.get(row.id) ?? []),
      }),
    ]),
  );
  return Object.freeze(
    claimHashes.flatMap((hash) => (byHash.has(hash) ? [byHash.get(hash)!] : [])),
  );
}
