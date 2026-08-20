import {
  applyAiDisclosure,
  imageHash,
  imageMetadata,
  inspectionPassed,
  normalizeGeneratedImage,
  normalizePublishedSourceImage,
  renderTemplateImage,
  type ImageInspectionResult,
  type ImageProvider,
} from '@geo-content-os/adapter-image';
import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import {
  DomainEventEnvelopeSchema,
  findDisallowedCompanyNames,
  findPublishedOwnerCompanyNames,
} from '@geo-content-os/contracts';
import type { QualityCheckerData, QualityIssue } from '@geo-content-os/contracts/skills';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import type { BaijiahaoAutomation, BaijiahaoQualityGate } from './baijiahao-automation.js';
import type {
  BrowserPlatformAutomation,
  BrowserPlatformQualityGate,
} from './browser-platform-automation.js';
import type { ContentMediaAutomationConfig } from './config.js';
import { validateMediaGenerationEvent } from './media-generation.event.js';
import type { ArticleImagePlan, ArticleImagePlanner } from './media-planner.js';
import type {
  OfficialSiteAutomation,
  OfficialSiteQualityGate,
} from './official-site-automation.js';
import type { ValidatedQualityEvent } from './quality.event.js';
import { safeError } from './safe-error.js';

export { safeError } from './safe-error.js';

type MediaStatus = 'fallback' | 'succeeded';

interface MediaClaim {
  readonly certificateSource: CertificateMediaSource | null;
  readonly content: Readonly<Record<string, unknown>>;
  readonly contentHash: string;
  readonly createdBy: string;
  readonly generationRunId: string;
  readonly generationModel: string | null;
  readonly inspectionModel: string | null;
  readonly manualPublishJobId: string | null;
  readonly platformCode: 'baijiahao' | 'lieju' | 'official_site' | 'sohu';
  readonly provider: string | null;
  readonly version: number;
}

interface CertificateMediaSource {
  readonly altText: string;
  readonly contentHash: string;
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly objectUri: string;
  readonly sourceDocumentId: string;
  readonly verificationUrl: string | null;
}

interface PreparedAsset {
  readonly altText: string;
  readonly body: Uint8Array;
  readonly position: number;
  readonly promptHash: string | null;
  readonly quality: Readonly<Record<string, unknown>>;
  readonly role: 'body' | 'cover';
  readonly source: 'certificate' | 'cloudflare' | 'template';
  readonly sourceDocumentId: string | null;
}

interface StoredAsset extends PreparedAsset {
  readonly contentHash: string;
  readonly height: number;
  readonly objectUri: string;
  readonly publicUrl: string | null;
  readonly sizeBytes: number;
  readonly width: number;
}

interface StoredQualityRow {
  readonly automationGate: unknown;
  readonly decision: string;
  readonly generationRunId: string;
  readonly geoScores: unknown;
  readonly issues: unknown;
  readonly score: number;
}

interface RecoverableMediaRun {
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly createdBy: string;
  readonly id: string;
  readonly packageId: string;
  readonly platformCode: 'baijiahao' | 'lieju' | 'official_site' | 'sohu';
  readonly projectId: string;
  readonly qualityReportId: string;
  readonly sourcePublishJobId: string | null;
  readonly tenantId: string;
  readonly validationMode: string | null;
  readonly variantId: string;
  readonly workspaceId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AI_DISCLOSURE_LABEL = 'AI示意图';
const AI_DISCLOSURE_STORAGE_VALUE = 'ai_generated';

export class ContentMediaWorker {
  public constructor(
    private readonly client: postgres.Sql,
    private readonly planner: ArticleImagePlanner,
    private readonly provider: ImageProvider | null,
    private readonly storage: ObjectStorageAdapter,
    private readonly officialSite: OfficialSiteAutomation,
    private readonly baijiahao: BaijiahaoAutomation,
    private readonly config: ContentMediaAutomationConfig,
    private readonly browserPlatform?: BrowserPlatformAutomation,
  ) {}

  public recoverStaleRuns(staleBefore = new Date(Date.now() - 10 * 60_000)): Promise<number> {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<RecoverableMediaRun[]>`
        SELECT run.id,run.tenant_id AS "tenantId",run.workspace_id AS "workspaceId",
          run.project_id AS "projectId",run.package_id AS "packageId",
          run.variant_id AS "variantId",run.content_version_id AS "contentVersionId",
          run.quality_report_id AS "qualityReportId",run.platform_code AS "platformCode",
          run.created_by AS "createdBy",version.content_hash AS "contentHash",
          run.diagnostics_json->'handoff'->>'source_publish_job_id' AS "sourcePublishJobId",
          run.diagnostics_json->'handoff'->>'validation_mode' AS "validationMode"
        FROM content_media_runs AS run
        JOIN content_versions AS version
          ON version.id=run.content_version_id AND version.tenant_id=run.tenant_id
        WHERE run.status='running' AND run.updated_at < ${staleBefore}
          AND (
            (
              run.platform_code='official_site' AND EXISTS (
                SELECT 1 FROM official_site_automation_runs AS automation
                WHERE automation.tenant_id=run.tenant_id
                  AND automation.variant_id=run.variant_id
                  AND automation.content_version_id=run.content_version_id
                  AND automation.last_quality_report_id=run.quality_report_id
                  AND automation.status='media_pending'
              )
            ) OR (
              run.platform_code='baijiahao' AND EXISTS (
                SELECT 1 FROM baijiahao_automation_runs AS automation
                WHERE automation.tenant_id=run.tenant_id
                  AND automation.variant_id=run.variant_id
                  AND automation.content_version_id=run.content_version_id
                  AND automation.last_quality_report_id=run.quality_report_id
                  AND automation.status='media_pending'
              )
            ) OR (
              run.platform_code IN ('sohu','lieju') AND EXISTS (
                SELECT 1 FROM browser_platform_automation_runs AS automation
                WHERE automation.tenant_id=run.tenant_id
                  AND automation.variant_id=run.variant_id
                  AND automation.content_version_id=run.content_version_id
                  AND automation.last_quality_report_id=run.quality_report_id
                  AND automation.platform_code=run.platform_code
                  AND automation.status='media_pending'
              )
            )
          )
        ORDER BY run.updated_at,run.id
        FOR UPDATE OF run SKIP LOCKED
      `;
      for (const row of rows) {
        const manualEdit =
          row.validationMode === 'manual_edit' &&
          typeof row.sourcePublishJobId === 'string' &&
          UUID_PATTERN.test(row.sourcePublishJobId);
        const recovered = await transaction<{ id: string }[]>`
          UPDATE content_media_runs SET status='queued',started_at=NULL,finished_at=NULL,
            last_error_json='{"code":"STALE_MEDIA_RUN_RECOVERED","schema_version":"content-media-error@1"}'::jsonb,
            version=version+1
          WHERE id=${row.id}::uuid AND tenant_id=${row.tenantId}::uuid AND status='running'
          RETURNING id
        `;
        if (recovered.length !== 1) continue;
        const event = DomainEventEnvelopeSchema.parse({
          aggregate: { id: row.id, type: 'content_media_run' },
          data: {
            actor_user_id: row.createdBy,
            content_hash: row.contentHash,
            content_version_id: row.contentVersionId,
            media_run_id: row.id,
            package_id: row.packageId,
            platform_code: row.platformCode,
            project_id: row.projectId,
            quality_report_id: row.qualityReportId,
            request_id: `media-recovery-${row.id}`.slice(0, 80),
            ...(manualEdit
              ? {
                  source_publish_job_id: row.sourcePublishJobId,
                  validation_mode: 'manual_edit',
                }
              : {}),
            variant_id: row.variantId,
            workspace_id: row.workspaceId,
          },
          event_id: randomUUID(),
          event_type: 'content.variant.media_generation_requested.v1',
          occurred_at: new Date().toISOString(),
          tenant: { id: row.tenantId },
        });
        await transaction`
          INSERT INTO outbox_events (
            id,tenant_id,event_type,aggregate_type,aggregate_id,payload_json
          ) VALUES (
            ${event.event_id}::uuid,${event.tenant.id}::uuid,${event.event_type},
            ${event.aggregate.type},${event.aggregate.id}::uuid,
            ${JSON.stringify(event)}::text::jsonb
          )
        `;
      }
      return rows.length;
    });
  }

  public async run(
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<{ readonly disposition: 'completed' | 'processed' }> {
    const event = validateMediaGenerationEvent(raw);
    const claim = await this.claim(event);
    if (!claim) return Object.freeze({ disposition: 'completed' });

    try {
      const plan = await this.planner.plan({
        content: claim.content,
        platformCode: claim.platformCode,
        requestId: event.data.requestId,
        scope: scope(event),
        ...(signal ? { signal } : {}),
      });
      if (plan.plannerFailure) {
        console.error('Article image planning failed; using template fallback', {
          contentVersionId: event.data.contentVersionId,
          error: plan.plannerFailure,
          mediaRunId: event.data.mediaRunId,
          platformCode: claim.platformCode,
          requestId: event.data.requestId,
        });
      }
      let prepared: Awaited<ReturnType<ContentMediaWorker['prepareAssets']>>;
      try {
        prepared = await this.prepareAssets(plan, claim, event.data.requestId, signal);
      } catch (error) {
        prepared = Object.freeze({
          assets: Object.freeze([]),
          externalCalls: 0,
          providerErrors: Object.freeze([safeError(error)]),
          sourceMediaErrors: Object.freeze([]),
          usedFallback: true,
        });
      }
      const stored: StoredAsset[] = [];
      const storageErrors: string[] = [];
      for (const asset of prepared.assets) {
        try {
          stored.push(await this.storeAsset(event.tenantId, event.data.contentVersionId, asset));
        } catch (error) {
          const failure = `${asset.role}[${asset.position}]: ${safeError(error)}`;
          storageErrors.push(failure);
          console.error('Content media asset storage failed', {
            contentVersionId: event.data.contentVersionId,
            error: failure,
            mediaRunId: event.data.mediaRunId,
            platformCode: claim.platformCode,
            requestId: event.data.requestId,
            source: asset.source,
          });
        }
      }

      const status: MediaStatus =
        prepared.usedFallback || stored.length !== prepared.assets.length
          ? 'fallback'
          : 'succeeded';
      await this.persistAndResume(event, claim, plan, stored, status, {
        external_calls: prepared.externalCalls,
        planner_failure: plan.plannerFailure,
        provider_failures: prepared.providerErrors,
        source_media_failures: prepared.sourceMediaErrors,
        storage_failures: storageErrors,
      });
      return Object.freeze({ disposition: 'processed' });
    } catch (error) {
      try {
        await this.releaseClaim(event, claim, error);
      } catch (releaseError) {
        console.error('Content media run lease release failed', {
          contentVersionId: event.data.contentVersionId,
          error: safeError(releaseError),
          mediaRunId: event.data.mediaRunId,
          platformCode: claim.platformCode,
          requestId: event.data.requestId,
        });
      }
      throw error;
    }
  }

  private async releaseClaim(
    event: ReturnType<typeof validateMediaGenerationEvent>,
    claim: MediaClaim,
    error: unknown,
  ): Promise<void> {
    const released = await this.client<{ id: string }[]>`
      UPDATE content_media_runs SET status='queued',started_at=NULL,finished_at=NULL,
        last_error_json=${JSON.stringify({
          code: 'CONTENT_MEDIA_RETRYABLE_FAILURE',
          message: safeError(error),
          schema_version: 'content-media-error@1',
        })}::text::jsonb,version=version+1
      WHERE id=${event.data.mediaRunId}::uuid AND tenant_id=${event.tenantId}::uuid
        AND status='running' AND version=${claim.version}
      RETURNING id
    `;
    if (released.length !== 1) throw new Error('Content media run lease was lost during release');
  }

  private claim(
    event: ReturnType<typeof validateMediaGenerationEvent>,
  ): Promise<MediaClaim | null> {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<
        (MediaClaim & { readonly status: string; readonly updatedAt: Date })[]
      >`
        SELECT run.status,run.version,run.created_by AS "createdBy",
          run.platform_code AS "platformCode",run.provider,
          run.generation_model AS "generationModel",run.inspection_model AS "inspectionModel",
          version.content_json AS content,version.content_hash AS "contentHash",
          report.generation_run_id AS "generationRunId",run.updated_at AS "updatedAt"
        FROM content_media_runs AS run
        JOIN content_versions AS version
          ON version.id=run.content_version_id AND version.tenant_id=run.tenant_id
        JOIN quality_reports AS report
          ON report.id=run.quality_report_id AND report.tenant_id=run.tenant_id
        WHERE run.id=${event.data.mediaRunId}::uuid AND run.tenant_id=${event.tenantId}::uuid
          AND run.workspace_id=${event.data.workspaceId}::uuid
          AND run.project_id=${event.data.projectId}::uuid
          AND run.package_id=${event.data.packageId}::uuid
          AND run.variant_id=${event.data.variantId}::uuid
          AND run.content_version_id=${event.data.contentVersionId}::uuid
          AND run.quality_report_id=${event.data.qualityReportId}::uuid
          AND run.platform_code=${event.data.platformCode}
        FOR UPDATE OF run
      `;
      const row = rows[0];
      if (!row || row.contentHash !== event.data.contentHash)
        throw new Error('Content media scope is invalid');
      if (row.status === 'succeeded' || row.status === 'fallback' || row.status === 'cancelled') {
        return null;
      }
      if (row.status === 'running' && Date.now() - row.updatedAt.getTime() < 120_000) {
        throw new Error('Content media generation is already running');
      }
      if (event.data.publishJobId) {
        const jobs = await transaction<{ id: string }[]>`
          SELECT id FROM publish_jobs
          WHERE id=${event.data.publishJobId}::uuid AND tenant_id=${event.tenantId}::uuid
            AND variant_id=${event.data.variantId}::uuid
            AND content_version_id=${event.data.contentVersionId}::uuid
            AND payload_hash=${event.data.contentHash} AND status='scheduled'
          FOR UPDATE
        `;
        if (!jobs[0]) {
          await transaction`
            UPDATE content_media_runs SET status='cancelled',finished_at=now(),
              last_error_json=${JSON.stringify({
                code: 'PUBLISH_JOB_NO_LONGER_SCHEDULED',
                message: 'The publish job is no longer scheduled',
              })}::text::jsonb,version=version+1
            WHERE id=${event.data.mediaRunId}::uuid AND tenant_id=${event.tenantId}::uuid
              AND status IN ('queued','running')
          `;
          return null;
        }
      }
      const changed = await transaction<{ version: number }[]>`
        UPDATE content_media_runs SET status='running',started_at=COALESCE(started_at,now()),
          finished_at=NULL,last_error_json=NULL,version=version+1
        WHERE id=${event.data.mediaRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status IN ('queued','running') AND version=${row.version}
        RETURNING version
      `;
      const lease = changed[0];
      if (!lease) throw new Error('Content media run lease was lost');
      const certificateSource =
        row.platformCode === 'lieju' ? null : await this.findCertificateSource(transaction, event);
      return Object.freeze({
        certificateSource,
        content: Object.freeze(row.content),
        contentHash: row.contentHash,
        createdBy: row.createdBy,
        generationModel: row.generationModel,
        generationRunId: row.generationRunId,
        inspectionModel: row.inspectionModel,
        manualPublishJobId: event.data.publishJobId,
        platformCode: row.platformCode,
        provider: row.provider,
        version: lease.version,
      });
    });
  }

  private async findCertificateSource(
    transaction: postgres.TransactionSql,
    event: ReturnType<typeof validateMediaGenerationEvent>,
  ): Promise<CertificateMediaSource | null> {
    const rows = await transaction<
      {
        certificateName: string;
        brandProfile: Readonly<Record<string, unknown>> | null;
        contentHash: string;
        holderName: string;
        mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
        objectUri: string;
        sourceDocumentId: string;
        verificationUrl: string | null;
      }[]
    >`
      SELECT source.id AS "sourceDocumentId",source.uri AS "objectUri",
        source.content_hash AS "contentHash",source.mime_type AS "mimeType",
        source.metadata_json->>'certificate_name' AS "certificateName",
        source.metadata_json->>'holder_name' AS "holderName",
        source.metadata_json->>'verification_url' AS "verificationUrl",
        brand.profile_json AS "brandProfile"
      FROM ai_citations AS citation
      JOIN source_chunks AS chunk
        ON chunk.id=citation.chunk_id AND chunk.tenant_id=citation.tenant_id
      JOIN source_documents AS source
        ON source.id=chunk.source_document_id AND source.tenant_id=chunk.tenant_id
      LEFT JOIN brand_profiles AS brand
        ON brand.tenant_id=source.tenant_id AND brand.workspace_id=source.workspace_id
        AND brand.status='published'
      WHERE citation.tenant_id=${event.tenantId}::uuid
        AND citation.content_version_id=${event.data.contentVersionId}::uuid
        AND source.workspace_id=${event.data.workspaceId}::uuid
        AND (source.project_id IS NULL OR source.project_id=${event.data.projectId}::uuid)
        AND source.source_type='image' AND source.status='active' AND source.deleted_at IS NULL
        AND source.trust_level <> 'untrusted'
        AND (source.effective_from IS NULL OR source.effective_from <= CURRENT_DATE)
        AND (source.effective_to IS NULL OR source.effective_to >= CURRENT_DATE)
        AND source.metadata_json->>'schema_version'='source-certificate@1'
        AND (source.metadata_json->>'article_use_allowed')::boolean IS TRUE
        AND (source.metadata_json->>'public_display_confirmed')::boolean IS TRUE
      ORDER BY source.updated_at DESC,source.id
      LIMIT 20
    `;
    const row = rows.find((candidate) =>
      findPublishedOwnerCompanyNames(candidate.brandProfile).includes(candidate.holderName.trim()),
    );
    if (!row) return null;
    return Object.freeze({
      altText: safeSourceAltText(`${row.holderName}的${row.certificateName}`, '企业证照', 220),
      contentHash: row.contentHash,
      mimeType: row.mimeType,
      objectUri: row.objectUri,
      sourceDocumentId: row.sourceDocumentId,
      verificationUrl: row.verificationUrl,
    });
  }

  private async prepareAssets(
    plan: ArticleImagePlan,
    claim: MediaClaim,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly assets: readonly PreparedAsset[];
    readonly externalCalls: number;
    readonly providerErrors: readonly string[];
    readonly sourceMediaErrors: readonly string[];
    readonly usedFallback: boolean;
  }> {
    const title = safeDisplayText(string(claim.content['title']) || '内容指南', '内容指南', 90);
    const assets: PreparedAsset[] = [
      {
        altText: `${title}封面示意图`,
        body: await renderTemplateImage({ accent: 'blue', label: plan.coverLabel, title }),
        position: 0,
        promptHash: null,
        quality: templateQuality(),
        role: 'cover',
        source: 'template',
        sourceDocumentId: null,
      },
    ];
    const providerErrors: string[] = [];
    const sourceMediaErrors: string[] = [];
    let externalCalls = 0;
    let usedFallback = plan.source === 'template' || !this.provider;
    for (const [index, scene] of plan.scenes.entries()) {
      let asset: PreparedAsset | null = null;
      if (plan.source === 'deepseek' && this.provider) {
        try {
          externalCalls += 1;
          const generated = await this.provider.generate({
            prompt: scene.prompt,
            requestId: `${requestId}:generate:${index + 1}`,
            seed: seed(claim.contentHash, index),
            ...(signal ? { signal } : {}),
            steps: this.config.generationSteps,
          });
          const normalized = await normalizeGeneratedImage(generated.body);
          externalCalls += 1;
          const inspection = await this.provider.inspect({
            body: normalized,
            expectedScene: inspectionScene(scene),
            mimeType: 'image/jpeg',
            requestId: `${requestId}:inspect:${index + 1}`,
            ...(signal ? { signal } : {}),
          });
          if (!inspectionPassed(inspection)) throw new Error('Generated image failed image QA');
          asset = {
            altText: safeDisplayText(scene.caption, `文章步骤${index + 1}示意图`, 220),
            body: await applyAiDisclosure(normalized),
            position: index + 1,
            promptHash: imageHash(new TextEncoder().encode(scene.prompt)),
            quality: providerQuality(inspection),
            role: 'body',
            source: 'cloudflare',
            sourceDocumentId: null,
          };
        } catch (error) {
          usedFallback = true;
          providerErrors.push(safeError(error));
        }
      }
      assets.push(
        asset ?? {
          altText: safeDisplayText(scene.caption, `文章步骤${index + 1}示意图`, 220),
          body: await renderTemplateImage({
            accent: index === 0 ? 'gold' : 'teal',
            label: safeDisplayText(scene.caption, `文章步骤${index + 1}`, 60),
            title,
          }),
          position: index + 1,
          promptHash: null,
          quality: templateQuality(),
          role: 'body',
          source: 'template',
          sourceDocumentId: null,
        },
      );
    }
    if (claim.certificateSource) {
      try {
        const original = await this.storage.getObject(
          storageKey(claim.certificateSource.objectUri),
        );
        if (imageHash(original) !== claim.certificateSource.contentHash) {
          throw new Error('Certificate image does not match its immutable source hash');
        }
        const position = Math.max(...assets.map((asset) => asset.position)) + 1;
        if (position > 10) throw new Error('No article image position remains for certificate');
        assets.push({
          altText: claim.certificateSource.altText,
          body: await normalizePublishedSourceImage(original),
          position,
          promptHash: null,
          quality: certificateQuality(claim.certificateSource),
          role: 'body',
          source: 'certificate',
          sourceDocumentId: claim.certificateSource.sourceDocumentId,
        });
      } catch (error) {
        usedFallback = true;
        sourceMediaErrors.push(safeError(error));
      }
    }
    return Object.freeze({
      assets: Object.freeze(assets),
      externalCalls,
      providerErrors: Object.freeze(providerErrors),
      sourceMediaErrors: Object.freeze(sourceMediaErrors),
      usedFallback,
    });
  }

  private async storeAsset(
    tenantId: string,
    contentVersionId: string,
    asset: PreparedAsset,
  ): Promise<StoredAsset> {
    const hash = imageHash(asset.body);
    const metadata = await imageMetadata(asset.body);
    const key = `generated-media/${tenantId}/${contentVersionId}/${asset.role}-${asset.position}-${hash}.jpg`;
    const stored = await this.storage.putObject({
      body: asset.body,
      contentHash: hash,
      contentType: 'image/jpeg',
      key,
      metadata: {
        // S3 user metadata is serialized as HTTP headers, so values must remain ASCII-safe.
        ai_disclosure:
          asset.source === 'certificate' ? 'not_ai_generated' : AI_DISCLOSURE_STORAGE_VALUE,
        content_version_id: contentVersionId,
        promotional_watermark: 'false',
        ...(asset.sourceDocumentId ? { source_document_id: asset.sourceDocumentId } : {}),
        source: asset.source,
        tenant_id: tenantId,
      },
    });
    return Object.freeze({
      ...asset,
      contentHash: hash,
      height: metadata.height,
      objectUri: stored.uri,
      publicUrl: this.config.publicBaseUrl ? `${this.config.publicBaseUrl}/${key}` : null,
      sizeBytes: metadata.sizeBytes,
      width: metadata.width,
    });
  }

  private persistAndResume(
    event: ReturnType<typeof validateMediaGenerationEvent>,
    claim: MediaClaim,
    plan: ArticleImagePlan,
    assets: readonly StoredAsset[],
    status: MediaStatus,
    diagnostics: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return this.client.begin(async (transaction) => {
      const qualityRows = await transaction<StoredQualityRow[]>`
        SELECT decision,score,issues_json AS issues,geo_scores_json AS "geoScores",
          automation_gate_json AS "automationGate",generation_run_id AS "generationRunId"
        FROM quality_reports
        WHERE id=${event.data.qualityReportId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND content_version_id=${event.data.contentVersionId}::uuid
          AND variant_id=${event.data.variantId}::uuid
      `;
      const storedQuality = qualityRows[0];
      if (!storedQuality || storedQuality.generationRunId !== claim.generationRunId) {
        throw new Error('Stored quality report scope is invalid');
      }
      const result = parseQualityResult(storedQuality);
      const gate = claim.manualPublishJobId
        ? null
        : parseQualityGate(storedQuality.automationGate, claim.platformCode);
      if (claim.manualPublishJobId && storedQuality.decision !== 'pass') {
        throw new Error('Stored quality report did not pass');
      }

      for (const asset of assets) {
        const metadata = {
          ai_disclosure: asset.source === 'certificate' ? null : AI_DISCLOSURE_LABEL,
          ai_generated: asset.source !== 'certificate',
          content_version_id: event.data.contentVersionId,
          height: asset.height,
          media_run_id: event.data.mediaRunId,
          model: asset.source === 'cloudflare' ? claim.generationModel : null,
          promotional_watermark: false,
          prompt_hash: asset.promptHash,
          provider:
            asset.source === 'cloudflare'
              ? claim.provider
              : asset.source === 'certificate'
                ? 'user_upload'
                : 'internal',
          role: asset.role,
          schema_version:
            asset.source === 'certificate' ? 'published-source-media@1' : 'generated-media@1',
          source: asset.source,
          ...(asset.sourceDocumentId
            ? { publication_authorized: true, source_document_id: asset.sourceDocumentId }
            : {}),
          width: asset.width,
        };
        const rows = await transaction<{ id: string }[]>`
          INSERT INTO media_assets (
            tenant_id,workspace_id,project_id,asset_type,object_uri,content_hash,
            mime_type,size_bytes,metadata_json,created_by
          ) VALUES (
            ${event.tenantId}::uuid,${event.data.workspaceId}::uuid,
            ${event.data.projectId}::uuid,'image',${asset.objectUri},${asset.contentHash},
            'image/jpeg',${asset.sizeBytes},${JSON.stringify(metadata)}::text::jsonb,
            ${claim.createdBy}::uuid
          )
          ON CONFLICT (tenant_id,object_uri) DO UPDATE SET object_uri=EXCLUDED.object_uri
          RETURNING id
        `;
        const mediaAssetId = rows[0]?.id;
        if (!mediaAssetId) throw new Error('Generated media asset was not persisted');
        await transaction`
          INSERT INTO content_media_assets (
            tenant_id,content_media_run_id,content_version_id,media_asset_id,
            role,position,alt_text,source,public_url,quality_json
          ) VALUES (
            ${event.tenantId}::uuid,${event.data.mediaRunId}::uuid,
            ${event.data.contentVersionId}::uuid,${mediaAssetId}::uuid,
            ${asset.role},${asset.position},${asset.altText},${asset.source},
            ${asset.publicUrl},${JSON.stringify(asset.quality)}::text::jsonb
          )
          ON CONFLICT (tenant_id,content_version_id,role,position) DO NOTHING
        `;
      }

      const completed = await transaction<{ id: string }[]>`
        UPDATE content_media_runs SET status=${status},plan_json=${JSON.stringify(plan)}::text::jsonb,
          diagnostics_json=${JSON.stringify(diagnostics)}::text::jsonb,
          finished_at=now(),last_error_json=NULL,version=version+1
        WHERE id=${event.data.mediaRunId}::uuid AND tenant_id=${event.tenantId}::uuid
          AND status='running' AND version=${claim.version}
        RETURNING id
      `;
      if (completed.length !== 1) throw new Error('Content media run lease was lost');

      if (claim.manualPublishJobId) {
        await transaction`
          INSERT INTO audit_events (
            tenant_id,actor_id,action,resource_type,resource_id,before_json,after_json,request_id
          ) VALUES (
            ${event.tenantId}::uuid,${event.data.actorUserId}::uuid,
            'publish_job.media_generated','publish_job',${claim.manualPublishJobId}::uuid,NULL,
            ${JSON.stringify({
              asset_count: assets.length,
              content_version_id: event.data.contentVersionId,
              media_run_id: event.data.mediaRunId,
              status,
            })}::text::jsonb,${event.data.requestId}
          )
        `;
        return;
      }

      if (!gate) throw new Error('Stored quality gate is unavailable');

      const qualityEvent: ValidatedQualityEvent = Object.freeze({
        data: Object.freeze({
          actorUserId: event.data.actorUserId,
          contentHash: event.data.contentHash,
          contentVersionId: event.data.contentVersionId,
          generationRunId: claim.generationRunId,
          packageId: event.data.packageId,
          projectId: event.data.projectId,
          requestId: event.data.requestId,
          sourcePublishJobId: event.data.sourcePublishJobId ?? null,
          validationMode: event.data.validationMode ?? 'full',
          variantId: event.data.variantId,
          workspaceId: event.data.workspaceId,
        }),
        eventId: event.eventId,
        tenantId: event.tenantId,
      });
      if (claim.platformCode === 'official_site') {
        if (gate.schema_version !== 'official-site-quality-gate@1') {
          throw new Error('Stored official-site quality gate is invalid');
        }
        const policy = await this.officialSite.loadGatePolicy(
          transaction,
          event.tenantId,
          event.data.variantId,
        );
        if (!policy) throw new Error('Official-site automation policy is unavailable');
        await transaction`
          UPDATE official_site_automation_runs SET status='quality_pending',version=version+1
          WHERE tenant_id=${event.tenantId}::uuid AND variant_id=${event.data.variantId}::uuid
            AND content_version_id=${event.data.contentVersionId}::uuid
            AND status='media_pending'
        `;
        await transaction`
          UPDATE official_site_daily_batch_items SET status='quality_check'
          WHERE tenant_id=${event.tenantId}::uuid AND variant_id=${event.data.variantId}::uuid
            AND content_version_id=${event.data.contentVersionId}::uuid
            AND status='media_pending'
        `;
        await this.officialSite.advanceAfterQuality(
          transaction,
          qualityEvent,
          policy,
          event.data.qualityReportId,
          gate,
          result,
        );
      } else if (claim.platformCode === 'baijiahao') {
        const policy = await this.baijiahao.loadGatePolicy(
          transaction,
          event.tenantId,
          event.data.variantId,
        );
        if (!policy) throw new Error('Baijiahao automation policy is unavailable');
        const runs = await transaction<{ id: string }[]>`
          UPDATE baijiahao_automation_runs SET status='quality_pending',version=version+1
          WHERE tenant_id=${event.tenantId}::uuid AND variant_id=${event.data.variantId}::uuid
            AND content_version_id=${event.data.contentVersionId}::uuid
            AND status='media_pending'
          RETURNING id
        `;
        const automationRunId = runs[0]?.id;
        if (!automationRunId) throw new Error('Baijiahao media state was not resumed');
        await transaction`
          UPDATE baijiahao_daily_batch_items SET status='quality_check'
          WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${automationRunId}::uuid
            AND content_version_id=${event.data.contentVersionId}::uuid
            AND status='media_pending'
        `;
        if (gate.schema_version !== 'baijiahao-quality-gate@1') {
          throw new Error('Stored Baijiahao quality gate is invalid');
        }
        await this.baijiahao.advanceAfterQuality(
          transaction,
          qualityEvent,
          policy,
          event.data.qualityReportId,
          gate,
          result,
        );
      } else {
        const policy = await this.browserPlatform?.loadGatePolicy(
          transaction,
          event.tenantId,
          event.data.variantId,
        );
        if (!policy) throw new Error('Browser platform automation policy is unavailable');
        const runs = await transaction<{ id: string }[]>`
          UPDATE browser_platform_automation_runs SET status='quality_pending',version=version+1
          WHERE tenant_id=${event.tenantId}::uuid AND variant_id=${event.data.variantId}::uuid
            AND content_version_id=${event.data.contentVersionId}::uuid
            AND platform_code=${claim.platformCode} AND status='media_pending'
          RETURNING id
        `;
        const automationRunId = runs[0]?.id;
        if (!automationRunId) throw new Error('Browser platform media state was not resumed');
        await transaction`
          UPDATE browser_platform_daily_batch_items SET status='quality_check'
          WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${automationRunId}::uuid
            AND content_version_id=${event.data.contentVersionId}::uuid
            AND status='media_pending'
        `;
        if (gate.schema_version !== 'browser-platform-quality-gate@1') {
          throw new Error('Stored browser platform quality gate is invalid');
        }
        if (!this.browserPlatform) throw new Error('Browser platform automation is unavailable');
        await this.browserPlatform.advanceAfterQuality(
          transaction,
          qualityEvent,
          policy,
          event.data.qualityReportId,
          gate,
          result,
        );
      }
    });
  }
}

function parseQualityResult(row: StoredQualityRow): QualityCheckerData {
  const issuesDocument = record(row.issues) ? row.issues : null;
  const geoDocument = record(row.geoScores) ? row.geoScores : null;
  const issues = issuesDocument?.['issues'];
  if (
    (row.decision !== 'pass' && row.decision !== 'revise' && row.decision !== 'block') ||
    !Array.isArray(issues) ||
    !geoDocument
  ) {
    throw new Error('Stored quality result is invalid');
  }
  return Object.freeze({
    decision: row.decision,
    geo_scores: geoDocument as unknown as QualityCheckerData['geo_scores'],
    issues: Object.freeze(issues as QualityIssue[]),
    score: row.score,
  });
}

function parseQualityGate(
  value: unknown,
  platformCode: 'baijiahao' | 'lieju' | 'official_site' | 'sohu',
): BaijiahaoQualityGate | BrowserPlatformQualityGate | OfficialSiteQualityGate {
  if (!record(value) || value['passed'] !== true || !Array.isArray(value['blocking_rules'])) {
    throw new Error('Stored quality gate is invalid');
  }
  const expected =
    platformCode === 'official_site'
      ? 'official-site-quality-gate@1'
      : platformCode === 'baijiahao'
        ? 'baijiahao-quality-gate@1'
        : 'browser-platform-quality-gate@1';
  if (value['schema_version'] !== expected)
    throw new Error('Stored quality gate platform is invalid');
  return value as unknown as
    BaijiahaoQualityGate | BrowserPlatformQualityGate | OfficialSiteQualityGate;
}

function templateQuality(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    decision: 'pass',
    method: 'deterministic_template',
    schema_version: 'content-image-quality@1',
  });
}

function providerQuality(value: ImageInspectionResult): Readonly<Record<string, unknown>> {
  return Object.freeze({
    article_relevance: value.articleRelevance,
    decision: 'pass',
    deceptive_realism: value.deceptiveRealism,
    detected_company_names: value.companyNames,
    detected_text: value.detectedText,
    issues: value.issues,
    logos_or_watermarks: value.logosOrWatermarks,
    model: value.modelId,
    phone_numbers: value.phoneNumbers,
    provider: value.providerCode,
    schema_version: 'content-image-quality@1',
    unsafe: value.unsafe,
  });
}

function certificateQuality(source: CertificateMediaSource): Readonly<Record<string, unknown>> {
  return Object.freeze({
    decision: 'pass',
    method: 'publication_attestation',
    schema_version: 'content-image-quality@1',
    source_document_id: source.sourceDocumentId,
    verification_url: source.verificationUrl,
  });
}

function inspectionScene(scene: ArticleImagePlan['scenes'][number]): string {
  return `Article scene (Chinese): ${scene.caption}\nPlanned visual representation (English): ${scene.prompt}`;
}

function safeDisplayText(value: string, fallback: string, maxLength: number): string {
  let normalized = value.trim();
  for (const company of findDisallowedCompanyNames(normalized)) {
    normalized = normalized.replaceAll(company, '某公司');
  }
  normalized = normalized
    .replace(/https?:\/\/\S+|www\.\S+/giu, '')
    .replace(/\b1[3-9]\d{9}\b/gu, '')
    .trim();
  return [...(normalized || fallback)].slice(0, maxLength).join('');
}

function safeSourceAltText(value: string, fallback: string, maxLength: number): string {
  const normalized = Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();
  return [...(normalized || fallback)].slice(0, maxLength).join('');
}

function seed(hash: string, index: number): number {
  return Number.parseInt(hash.slice(index * 8, index * 8 + 8), 16) & 0x7fffffff || index + 1;
}

function scope(event: ReturnType<typeof validateMediaGenerationEvent>) {
  return Object.freeze({
    packageId: event.data.packageId,
    projectId: event.data.projectId,
    tenantId: event.tenantId,
    variantId: event.data.variantId,
    workspaceId: event.data.workspaceId,
  });
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storageKey(uri: string): string {
  const match = /^(?:s3|memory):\/\/[^/]+\/(.+)$/u.exec(uri);
  if (!match?.[1]) throw new Error('Certificate source object URI is invalid');
  const key = decodeURIComponent(match[1]);
  if (!key || key.startsWith('/') || key.includes('..')) {
    throw new Error('Certificate source object key is invalid');
  }
  return key;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
