import type { BrandProfile, ContentVariantStatus, PlatformCode } from '@geo-content-os/contracts';
import type { QualityDecision } from '@geo-content-os/contracts/skills';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';
import type {
  QualityGeoScoresDocument,
  QualityIssuesDocument,
} from '../../../database/schema/index.js';
import { RequiredAuditWriter } from '../../audit/index.js';
import { QualityPipelineError } from './quality-pipeline.errors.js';
import type {
  LoadedQualityContext,
  PreparedQualityReport,
  QualityFactInput,
  QualityPipelineRequest,
  QualityPipelineScope,
  QualityReportView,
} from './quality-pipeline.types.js';

type SqlClient = DatabaseClient | TransactionSql;

interface ContextRow {
  readonly brandProfileId: string;
  readonly brandProfileJson: BrandProfile;
  readonly brandProfileVersion: number;
  readonly content: Readonly<Record<string, unknown>>;
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly generationRunVersion: number;
  readonly platformCode: PlatformCode;
  readonly variantStatus: ContentVariantStatus;
  readonly variantVersion: number;
}

interface FactRow extends Omit<QualityFactInput, 'citation_ids' | 'confidence'> {
  readonly confidence: string;
  readonly id: string;
}

interface ReportRow {
  readonly checkerVersion: string;
  readonly contentVersionId: string;
  readonly createdAt: Date;
  readonly decision: QualityDecision;
  readonly generationRunId: string;
  readonly geoScoresJson: QualityGeoScoresDocument;
  readonly id: string;
  readonly issuesJson: QualityIssuesDocument;
  readonly score: string;
  readonly tenantId: string;
  readonly variantId: string;
  readonly variantStatus: ContentVariantStatus;
  readonly variantVersion: number;
}

export class QualityPipelineRepository {
  public constructor(
    private readonly client: DatabaseClient,
    private readonly auditWriter: RequiredAuditWriter = new RequiredAuditWriter(),
  ) {}

  public async findByRun(scope: QualityPipelineScope): Promise<QualityReportView | undefined> {
    return selectReport(this.client, scope);
  }

  public async loadContext(
    scope: QualityPipelineScope,
    request: QualityPipelineRequest,
  ): Promise<LoadedQualityContext> {
    const rows = await this.client<ContextRow[]>`
      SELECT
        run.version AS "generationRunVersion",
        variant.platform_code AS "platformCode",
        variant.status AS "variantStatus",
        variant.version AS "variantVersion",
        version.id AS "contentVersionId",
        version.content_hash AS "contentHash",
        version.content_json AS content,
        brand.id AS "brandProfileId",
        brand.version AS "brandProfileVersion",
        brand.profile_json AS "brandProfileJson"
      FROM generation_runs AS run
      JOIN content_variants AS variant
        ON variant.id = run.variant_id
        AND variant.tenant_id = run.tenant_id
        AND variant.package_id = run.package_id
      JOIN content_packages AS package
        ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
      JOIN content_versions AS version
        ON version.id = ${request.contentVersionId}::uuid
        AND version.tenant_id = variant.tenant_id
        AND version.package_id = variant.package_id
        AND version.variant_id = variant.id
      JOIN brand_profiles AS brand
        ON brand.id = ${request.brandProfileId}::uuid
        AND brand.tenant_id = run.tenant_id
        AND brand.workspace_id = run.workspace_id
        AND brand.status = 'published'
      WHERE
        run.id = ${scope.generationRunId}::uuid
        AND run.tenant_id = ${scope.tenantId}::uuid
        AND run.workspace_id = ${scope.workspaceId}::uuid
        AND run.project_id = ${scope.projectId}::uuid
        AND run.variant_id = ${scope.variantId}::uuid
        AND run.skill_name = 'quality-checker'
        AND run.status = 'running'
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
        AND package.deleted_at IS NULL
        AND variant.current_content_version_id = version.id
        AND has_project_scope_access(
          package.tenant_id,
          package.workspace_id,
          package.project_id,
          ${scope.userId}::uuid
        )
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) notFound();
    if (row.variantVersion !== request.expectedVariantVersion) {
      throw new QualityPipelineError('QUALITY_VERSION_CONFLICT', 'Variant version is stale');
    }
    const factResults = await selectFactResults(
      this.client,
      scope,
      request.factCheckGenerationRunId,
    );
    return Object.freeze({
      brandProfile: Object.freeze({
        brand_profile_id: row.brandProfileId,
        policy: Object.freeze(row.brandProfileJson),
        version: row.brandProfileVersion,
      }),
      content: Object.freeze({
        content: Object.freeze(row.content),
        content_hash: row.contentHash,
        content_version_id: row.contentVersionId,
        variant_id: scope.variantId,
      }),
      factResults,
      generationRunVersion: row.generationRunVersion,
      platformCode: row.platformCode,
      variantStatus: row.variantStatus,
      variantVersion: row.variantVersion,
    });
  }

  public async persist(
    scope: QualityPipelineScope,
    prepared: PreparedQualityReport,
  ): Promise<QualityReportView> {
    return this.client.begin(async (transaction) => {
      const existing = await selectReport(transaction, scope);
      if (existing) {
        if (
          existing.contentVersionId !== prepared.contentVersionId ||
          existing.checkerVersion !== prepared.checkerVersion
        ) {
          throw new QualityPipelineError(
            'QUALITY_IDEMPOTENCY_CONFLICT',
            'Quality run already has a report for different immutable input',
          );
        }
        return existing;
      }

      const locked = await transaction<
        {
          runVersion: number;
          variantStatus: ContentVariantStatus;
          variantVersion: number;
        }[]
      >`
        SELECT
          run.version AS "runVersion",
          variant.status AS "variantStatus",
          variant.version AS "variantVersion"
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
          AND run.skill_name = 'quality-checker'
          AND run.status = 'running'
          AND package.workspace_id = ${scope.workspaceId}::uuid
          AND package.project_id = ${scope.projectId}::uuid
          AND package.deleted_at IS NULL
          AND variant.current_content_version_id = ${prepared.contentVersionId}::uuid
        FOR UPDATE OF run, variant
      `;
      const state = locked[0];
      if (!state) notFound();
      if (
        state.runVersion !== prepared.expectedGenerationRunVersion ||
        state.variantVersion !== prepared.expectedVariantVersion
      ) {
        throw new QualityPipelineError(
          'QUALITY_VERSION_CONFLICT',
          'Quality run or Variant changed',
        );
      }
      const targetStatus = targetVariantStatus(prepared.decision, state.variantStatus);
      const issuesDocument = JSON.stringify({
        issues: prepared.issues,
        schema_version: 'quality-checker-data@1',
      });
      const geoDocument = JSON.stringify({
        ...prepared.geoScores,
        schema_version: 'geo-scores@1',
      });
      const reports = await transaction<{ id: string }[]>`
        INSERT INTO quality_reports (
          tenant_id, variant_id, content_version_id, generation_run_id,
          checker_version, score, decision, issues_json, geo_scores_json
        ) VALUES (
          ${scope.tenantId}::uuid,
          ${scope.variantId}::uuid,
          ${prepared.contentVersionId}::uuid,
          ${scope.generationRunId}::uuid,
          ${prepared.checkerVersion},
          ${prepared.score},
          ${prepared.decision},
          ${issuesDocument}::text::jsonb,
          ${geoDocument}::text::jsonb
        )
        RETURNING id
      `;
      const reportId = reports[0]?.id;
      if (!reportId) throw new Error('Quality report insert returned no row');
      const variants = await transaction<{ version: number }[]>`
        UPDATE content_variants
        SET
          status = ${targetStatus},
          quality_score = ${prepared.score},
          version = version + 1
        WHERE
          id = ${scope.variantId}::uuid
          AND tenant_id = ${scope.tenantId}::uuid
          AND version = ${prepared.expectedVariantVersion}
          AND current_content_version_id = ${prepared.contentVersionId}::uuid
        RETURNING version
      `;
      const variantVersion = variants[0]?.version;
      if (!variantVersion) {
        throw new QualityPipelineError('QUALITY_VERSION_CONFLICT', 'Variant update lost its lease');
      }
      const runs = await transaction<{ version: number }[]>`
        UPDATE generation_runs
        SET status = 'succeeded', finished_at = now(), error_json = NULL, version = version + 1
        WHERE
          id = ${scope.generationRunId}::uuid
          AND tenant_id = ${scope.tenantId}::uuid
          AND status = 'running'
          AND version = ${prepared.expectedGenerationRunVersion}
        RETURNING version
      `;
      if (runs.length !== 1) {
        throw new QualityPipelineError(
          'QUALITY_VERSION_CONFLICT',
          'Quality run update lost its lease',
        );
      }
      await this.auditWriter.record(transaction, {
        action: 'content.variant.quality_checked',
        actorId: scope.userId,
        after: {
          decision: prepared.decision,
          quality_report_id: reportId,
          quality_score: prepared.score,
          status: targetStatus,
          version: variantVersion,
        },
        before: {
          status: state.variantStatus,
          version: state.variantVersion,
        },
        requestId: prepared.requestId,
        resourceId: scope.variantId,
        resourceType: 'content_variant',
        tenantId: scope.tenantId,
      });
      const report = await selectReport(transaction, scope);
      if (!report) throw new Error('Committed quality report could not be read');
      return report;
    });
  }
}

async function selectFactResults(
  client: SqlClient,
  scope: QualityPipelineScope,
  factRunId: string,
): Promise<readonly QualityFactInput[]> {
  const runs = await client<{ id: string }[]>`
    SELECT run.id
    FROM generation_runs AS run
    JOIN content_variants AS variant
      ON variant.id = run.variant_id
      AND variant.tenant_id = run.tenant_id
      AND variant.package_id = run.package_id
    JOIN content_packages AS package
      ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
    WHERE
      run.id = ${factRunId}::uuid
      AND run.tenant_id = ${scope.tenantId}::uuid
      AND run.workspace_id = ${scope.workspaceId}::uuid
      AND run.project_id = ${scope.projectId}::uuid
      AND run.variant_id = ${scope.variantId}::uuid
      AND run.skill_name = 'fact-checker'
      AND package.workspace_id = ${scope.workspaceId}::uuid
      AND package.project_id = ${scope.projectId}::uuid
    LIMIT 1
  `;
  if (runs.length !== 1) notFound();
  const facts = await client<FactRow[]>`
    SELECT
      result.id,
      result.claim_key AS claim_key,
      result.claim_text AS claim_text,
      result.verdict,
      result.risk_level AS risk_level,
      result.confidence::text AS confidence
    FROM fact_check_results AS result
    WHERE
      result.tenant_id = ${scope.tenantId}::uuid
      AND result.generation_run_id = ${factRunId}::uuid
      AND result.variant_id = ${scope.variantId}::uuid
    ORDER BY result.created_at, result.id
  `;
  if (facts.length === 0) return Object.freeze([]);
  const resultIds = facts.map((fact) => fact.id);
  const evidences = await client<{ factCheckResultId: string; id: string }[]>`
    SELECT id, fact_check_result_id AS "factCheckResultId"
    FROM fact_evidences
    WHERE
      tenant_id = ${scope.tenantId}::uuid
      AND fact_check_result_id = ANY(${client.array(resultIds)}::uuid[])
    ORDER BY created_at, id
  `;
  const citations = new Map<string, string[]>();
  for (const evidence of evidences) {
    const ids = citations.get(evidence.factCheckResultId) ?? [];
    ids.push(evidence.id);
    citations.set(evidence.factCheckResultId, ids);
  }
  return Object.freeze(
    facts.map((fact) =>
      Object.freeze({
        citation_ids: Object.freeze(citations.get(fact.id) ?? []),
        claim_key: fact.claim_key,
        claim_text: fact.claim_text,
        confidence: Number(fact.confidence),
        risk_level: fact.risk_level,
        verdict: fact.verdict,
      }),
    ),
  );
}

async function selectReport(
  client: SqlClient,
  scope: QualityPipelineScope,
): Promise<QualityReportView | undefined> {
  const rows = await client<ReportRow[]>`
    SELECT
      report.id,
      report.tenant_id AS "tenantId",
      report.variant_id AS "variantId",
      report.content_version_id AS "contentVersionId",
      report.generation_run_id AS "generationRunId",
      report.checker_version AS "checkerVersion",
      report.score::text AS score,
      report.decision,
      report.issues_json AS "issuesJson",
      report.geo_scores_json AS "geoScoresJson",
      report.created_at AS "createdAt",
      variant.status AS "variantStatus",
      variant.version AS "variantVersion"
    FROM quality_reports AS report
    JOIN content_variants AS variant
      ON variant.id = report.variant_id AND variant.tenant_id = report.tenant_id
    JOIN content_packages AS package
      ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
    JOIN generation_runs AS run
      ON run.id = report.generation_run_id
      AND run.tenant_id = report.tenant_id
      AND run.variant_id = report.variant_id
    WHERE
      report.tenant_id = ${scope.tenantId}::uuid
      AND report.generation_run_id = ${scope.generationRunId}::uuid
      AND report.variant_id = ${scope.variantId}::uuid
      AND run.workspace_id = ${scope.workspaceId}::uuid
      AND run.project_id = ${scope.projectId}::uuid
      AND package.workspace_id = ${scope.workspaceId}::uuid
      AND package.project_id = ${scope.projectId}::uuid
      AND has_project_scope_access(
        package.tenant_id,
        package.workspace_id,
        package.project_id,
        ${scope.userId}::uuid
      )
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return undefined;
  const geoScores = {
    answerability: row.geoScoresJson.answerability,
    entity: row.geoScoresJson.entity,
    evidence: row.geoScoresJson.evidence,
    platform_fit: row.geoScoresJson.platform_fit,
    question: row.geoScoresJson.question,
    readability_safety: row.geoScoresJson.readability_safety,
    total: row.geoScoresJson.total,
  };
  return Object.freeze({
    checkerVersion: row.checkerVersion,
    contentVersionId: row.contentVersionId,
    createdAt: row.createdAt,
    decision: row.decision,
    generationRunId: row.generationRunId,
    geoScores: Object.freeze(geoScores),
    id: row.id,
    issues: Object.freeze(row.issuesJson.issues),
    score: Number(row.score),
    tenantId: row.tenantId,
    variantId: row.variantId,
    variantStatus: row.variantStatus,
    variantVersion: row.variantVersion,
  });
}

function targetVariantStatus(
  decision: QualityDecision,
  current: ContentVariantStatus,
): 'quality_failed' | 'quality_passed' {
  const target = decision === 'pass' ? 'quality_passed' : 'quality_failed';
  const allowed =
    target === 'quality_passed'
      ? new Set<ContentVariantStatus>(['generated', 'quality_failed', 'quality_passed'])
      : new Set<ContentVariantStatus>([
          'approved',
          'generated',
          'published',
          'quality_failed',
          'quality_passed',
          'review_rejected',
        ]);
  if (!allowed.has(current)) {
    throw new QualityPipelineError(
      'QUALITY_STATE_INVALID',
      `Variant status ${current} cannot accept a quality result`,
    );
  }
  return target;
}

function notFound(): never {
  throw new QualityPipelineError(
    'QUALITY_SCOPE_NOT_FOUND',
    'Quality run, Variant, content version, brand profile, or fact run was not found in scope',
  );
}
