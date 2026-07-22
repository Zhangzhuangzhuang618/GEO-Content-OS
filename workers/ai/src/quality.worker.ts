import type { ModelUsage } from '@geo-content-os/adapter-model';
import type { PlatformCode } from '@geo-content-os/contracts';
import type { QualityCheckerData, QualityGeoScores } from '@geo-content-os/contracts/skills';
import type postgres from 'postgres';

import { asGenerationFailure } from './generation.errors.js';
import { validateQualityEvent, type ValidatedQualityEvent } from './quality.event.js';
import { RuntimeQualityChecker } from './runtime-quality-checker.js';
import type { UsageContext } from './usage-recorder.js';

interface QualityContext extends UsageContext {
  readonly actorUserId: string;
  readonly brandProfileId: string;
  readonly brandProfile: Readonly<Record<string, unknown>>;
  readonly brandVersion: number;
  readonly content: Readonly<Record<string, unknown>>;
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly inputHash: string;
  readonly leaseVersion: number;
  readonly modelKey: string;
  readonly platformCode: PlatformCode;
  readonly promptVersionId: string;
  readonly requestId: string;
  readonly ruleId: string;
  readonly ruleHash: string;
  readonly rules: Readonly<Record<string, unknown>>;
  readonly skillVersion: string;
  readonly variantStatus: string;
  readonly variantVersion: number;
}

interface CitationRow {
  readonly claimKey: string;
  readonly claimText: string;
  readonly id: string;
}

export class QualityCheckWorker {
  public constructor(
    private readonly client: postgres.Sql,
    private readonly checker: RuntimeQualityChecker,
  ) {}

  public async run(raw: unknown): Promise<{ readonly disposition: 'completed' | 'processed' }> {
    const event = validateQualityEvent(raw);
    const context = await this.claim(event);
    if (!context) return { disposition: 'completed' };
    try {
      const [citations, duplicates] = await Promise.all([
        this.loadCitations(event),
        this.loadDuplicates(event),
      ]);
      const geoScores = calculateGeoScores(
        context.content,
        citations,
        context.platformCode,
        context.brandProfile,
        context.rules,
      );
      const result = await this.checker.evaluate({
        context,
        qualityInput: {
          brand_policy: {
            brand_profile_id: context.brandProfileId,
            policy: context.brandProfile,
            version: context.brandVersion,
          },
          content_version: {
            content: context.content,
            content_hash: context.contentHash,
            content_version_id: context.contentVersionId,
            variant_id: event.data.variantId,
          },
          duplicate_matches: duplicates,
          fact_results: groupCitations(citations),
          geo_result: { scores: geoScores },
          platform_rules: {
            platform_code: context.platformCode,
            rules: context.rules,
            rules_hash: context.ruleHash,
            version_id: context.ruleId,
          },
          safety_policy: {
            block_on_data_leakage: true,
            block_on_injection: true,
            max_warnings_for_pass: 0,
          },
        },
      });
      await this.persist(event, context, result);
      return { disposition: 'processed' };
    } catch (error) {
      await this.fail(event, context, error);
      throw error;
    }
  }

  private claim(event: ValidatedQualityEvent): Promise<QualityContext | null> {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<
        Omit<QualityContext, 'actorUserId' | 'leaseVersion' | 'skillName'>[]
      >`
        SELECT
          brand.id AS "brandProfileId",
          brand.profile_json AS "brandProfile",
          brand.version AS "brandVersion",
          version.content_json AS content,
          version.content_hash AS "contentHash",
          version.id AS "contentVersionId",
          run.id AS "runId",
          run.input_hash AS "inputHash",
          run.model_key AS "modelKey",
          run.package_id AS "packageId",
          variant.platform_code AS "platformCode",
          run.project_id AS "projectId",
          run.prompt_version_id AS "promptVersionId",
          run.request_id AS "requestId",
          rule.id AS "ruleId",
          rule.content_hash AS "ruleHash",
          rule.rules_json AS rules,
          run.skill_version AS "skillVersion",
          run.status,
          run.tenant_id AS "tenantId",
          run.variant_id AS "variantId",
          variant.status AS "variantStatus",
          variant.version AS "variantVersion",
          run.version AS "runVersion",
          run.updated_at AS "updatedAt",
          run.workspace_id AS "workspaceId"
        FROM generation_runs AS run
        JOIN content_variants AS variant
          ON variant.id = run.variant_id
          AND variant.tenant_id = run.tenant_id
          AND variant.package_id = run.package_id
        JOIN content_packages AS package
          ON package.id = variant.package_id
          AND package.tenant_id = variant.tenant_id
          AND package.workspace_id = run.workspace_id
          AND package.project_id = run.project_id
        JOIN content_versions AS version
          ON version.id = ${event.data.contentVersionId}::uuid
          AND version.tenant_id = variant.tenant_id
          AND version.package_id = variant.package_id
          AND version.variant_id = variant.id
        JOIN brand_profiles AS brand
          ON brand.tenant_id = run.tenant_id
          AND brand.workspace_id = run.workspace_id
          AND brand.status = 'published'
        JOIN LATERAL (
          SELECT id, content_hash, rules_json
          FROM platform_rule_versions
          WHERE platform_code = variant.platform_code AND status = 'published'
          ORDER BY published_at DESC NULLS LAST, created_at DESC, id DESC
          LIMIT 1
        ) AS rule ON true
        WHERE
          run.id = ${event.data.generationRunId}::uuid
          AND run.tenant_id = ${event.tenantId}::uuid
          AND run.variant_id = ${event.data.variantId}::uuid
          AND run.package_id = ${event.data.packageId}::uuid
          AND run.project_id = ${event.data.projectId}::uuid
          AND run.workspace_id = ${event.data.workspaceId}::uuid
          AND run.skill_name = 'quality-checker'
          AND variant.current_content_version_id = version.id
          AND version.content_hash = ${event.data.contentHash}
          AND package.deleted_at IS NULL
          AND has_project_scope_access(
            run.tenant_id,
            run.workspace_id,
            run.project_id,
            ${event.data.actorUserId}::uuid
          )
        FOR UPDATE OF run, variant
      `;
      const row = rows[0] as
        | (Omit<QualityContext, 'actorUserId' | 'leaseVersion' | 'skillName'> & {
            readonly runVersion: number;
            readonly status: string;
            readonly updatedAt: Date;
          })
        | undefined;
      if (!row) throw new Error('Quality run scope is invalid');
      if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
        return null;
      }
      if (row.status === 'running' && Date.now() - row.updatedAt.getTime() < 60_000) {
        return null;
      }
      if (row.status !== 'queued' && row.status !== 'running') {
        throw new Error('Quality run state is invalid');
      }
      const claimed = await transaction<{ version: number }[]>`
        UPDATE generation_runs
        SET
          status = 'running',
          started_at = COALESCE(started_at, now()),
          finished_at = NULL,
          error_json = NULL,
          version = version + 1
        WHERE id = ${event.data.generationRunId}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND version = ${row.runVersion}
        RETURNING version
      `;
      const lease = claimed[0];
      if (!lease) throw new Error('Quality run lease was lost');
      return Object.freeze({
        ...row,
        actorUserId: event.data.actorUserId,
        leaseVersion: lease.version,
        skillName: 'quality-checker',
      });
    });
  }

  private async loadCitations(event: ValidatedQualityEvent): Promise<readonly CitationRow[]> {
    return this.client<CitationRow[]>`
      SELECT id, claim_key AS "claimKey", claim_text AS "claimText"
      FROM ai_citations
      WHERE tenant_id = ${event.tenantId}::uuid
        AND content_version_id = ${event.data.contentVersionId}::uuid
      ORDER BY claim_key, id
    `;
  }

  private async loadDuplicates(event: ValidatedQualityEvent) {
    const rows = await this.client<{ contentVersionId: string; excerpt: string | null }[]>`
      SELECT
        version.id AS "contentVersionId",
        left(version.content_json->>'summary', 500) AS excerpt
      FROM content_versions AS version
      JOIN content_packages AS package
        ON package.id = version.package_id AND package.tenant_id = version.tenant_id
      WHERE version.tenant_id = ${event.tenantId}::uuid
        AND package.project_id = ${event.data.projectId}::uuid
        AND version.content_hash = ${event.data.contentHash}
        AND version.id <> ${event.data.contentVersionId}::uuid
      ORDER BY version.created_at DESC, version.id DESC
      LIMIT 10
    `;
    return rows.map((row) => ({
      content_version_id: row.contentVersionId,
      excerpt: row.excerpt,
      similarity: 1,
    }));
  }

  private persist(
    event: ValidatedQualityEvent,
    context: QualityContext,
    result: QualityCheckerData,
  ): Promise<void> {
    return this.client.begin(async (transaction) => {
      const targetStatus = result.decision === 'pass' ? 'quality_passed' : 'quality_failed';
      const reports = await transaction<{ id: string }[]>`
        INSERT INTO quality_reports (
          tenant_id, variant_id, content_version_id, generation_run_id,
          checker_version, score, decision, issues_json, geo_scores_json
        ) VALUES (
          ${event.tenantId}::uuid,
          ${event.data.variantId}::uuid,
          ${event.data.contentVersionId}::uuid,
          ${event.data.generationRunId}::uuid,
          ${context.skillVersion},
          ${result.score},
          ${result.decision},
          ${JSON.stringify({ issues: result.issues, schema_version: 'quality-checker-data@1' })}::text::jsonb,
          ${JSON.stringify({ ...result.geo_scores, schema_version: 'geo-scores@1' })}::text::jsonb
        )
        ON CONFLICT (tenant_id, generation_run_id) DO NOTHING
        RETURNING id
      `;
      const existing = reports[0]
        ? reports
        : await transaction<{ id: string }[]>`
            SELECT id FROM quality_reports
            WHERE tenant_id = ${event.tenantId}::uuid
              AND generation_run_id = ${event.data.generationRunId}::uuid
          `;
      const reportId = existing[0]?.id;
      if (!reportId) throw new Error('Quality report was not persisted');
      const variants = await transaction<{ version: number }[]>`
        UPDATE content_variants
        SET status = ${targetStatus}, quality_score = ${result.score}, version = version + 1
        WHERE id = ${event.data.variantId}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND version = ${context.variantVersion}
          AND current_content_version_id = ${event.data.contentVersionId}::uuid
          AND status IN ('generated', 'quality_failed', 'quality_passed')
        RETURNING version
      `;
      const variant = variants[0];
      if (!variant) throw new Error('Quality result no longer matches the current content');
      const runs = await transaction<{ id: string }[]>`
        UPDATE generation_runs
        SET status = 'succeeded', finished_at = now(), error_json = NULL, version = version + 1
        WHERE id = ${event.data.generationRunId}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND status = 'running'
          AND version = ${context.leaseVersion}
        RETURNING id
      `;
      if (runs.length !== 1) throw new Error('Quality run lease was lost');
      await transaction`
        INSERT INTO audit_events (
          tenant_id, actor_id, action, resource_type, resource_id,
          before_json, after_json, request_id
        ) VALUES (
          ${event.tenantId}::uuid,
          ${event.data.actorUserId}::uuid,
          'content.variant.quality_checked',
          'content_variant',
          ${event.data.variantId}::uuid,
          ${JSON.stringify({ status: context.variantStatus, version: context.variantVersion })}::text::jsonb,
          ${JSON.stringify({ decision: result.decision, quality_report_id: reportId, quality_score: result.score, status: targetStatus, version: variant.version })}::text::jsonb,
          ${event.data.requestId}
        )
      `;
    });
  }

  private async fail(
    event: ValidatedQualityEvent,
    context: QualityContext,
    error: unknown,
  ): Promise<void> {
    const failure = asGenerationFailure(error);
    await this.client`
      UPDATE generation_runs
      SET
        status = 'failed',
        finished_at = now(),
        error_json = ${JSON.stringify({
          code: failure.code === 'GENERATION_FAILED' ? 'QUALITY_CHECK_FAILED' : failure.code,
          message: failure.message,
        })}::text::jsonb,
        version = version + 1
      WHERE id = ${event.data.generationRunId}::uuid
        AND tenant_id = ${event.tenantId}::uuid
        AND status = 'running'
        AND version = ${context.leaseVersion}
    `;
  }
}

export type QualityUsageRecorder = (context: UsageContext, usage: ModelUsage) => Promise<void>;

function groupCitations(citations: readonly CitationRow[]) {
  const groups = new Map<string, CitationRow[]>();
  for (const citation of citations) {
    const group = groups.get(citation.claimKey) ?? [];
    group.push(citation);
    groups.set(citation.claimKey, group);
  }
  return [...groups.entries()].map(([claimKey, group]) => ({
    citation_ids: group.map((citation) => citation.id),
    claim_key: claimKey,
    claim_text: group[0]!.claimText,
    confidence: 1,
    risk_level: 'low',
    verdict: 'supported',
  }));
}

function calculateGeoScores(
  content: Readonly<Record<string, unknown>>,
  citations: readonly CitationRow[],
  platformCode: PlatformCode,
  brandProfile: Readonly<Record<string, unknown>>,
  rules: Readonly<Record<string, unknown>>,
): QualityGeoScores {
  const title = typeof content['title'] === 'string' ? content['title'] : '';
  const summary = typeof content['summary'] === 'string' ? content['summary'] : '';
  const blocks = Array.isArray(content['blocks']) ? content['blocks'] : [];
  const text = `${title}\n${summary}\n${blocks
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('\n')}`;
  const characterCount = [...text].length;
  const question = /[？?]|如何|怎么|为什么|哪些|是否|指南|方法/u.test(title) ? 90 : 72;
  const answerability = Math.min(95, 55 + blocks.length * 5 + (summary.length >= 30 ? 10 : 0));
  const entity = /公司|品牌|服务|产品|机构/u.test(text) ? 88 : 72;
  const acceptsFirstPartyFacts =
    platformCode === 'official_site' &&
    rules['accepted_first_party_source'] === 'published_brand_profile' &&
    Object.keys(brandProfile).length > 0;
  const evidence =
    citations.length > 0
      ? Math.min(95, 65 + citations.length * 5)
      : acceptsFirstPartyFacts
        ? 80
        : 55;
  const titleLimits: Readonly<Record<PlatformCode, number>> = {
    baijiahao: 40,
    douyin: 80,
    official_site: 60,
    toutiao: 50,
    wechat_mp: 64,
    xiaohongshu: 20,
    zhihu: 80,
  };
  const platformFit = title.length > 0 && [...title].length <= titleLimits[platformCode] ? 90 : 45;
  const readabilitySafety = characterCount >= 300 && blocks.length >= 3 ? 90 : 68;
  const total = round(
    0.2 * (entity + question + answerability + evidence) + 0.1 * (platformFit + readabilitySafety),
  );
  return Object.freeze({
    answerability,
    entity,
    evidence,
    platform_fit: platformFit,
    question,
    readability_safety: readabilitySafety,
    total,
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
