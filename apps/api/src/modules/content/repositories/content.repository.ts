import type {
  BriefConstraints,
  ContentPackageStatus,
  ContentVariantStatus,
  PlatformCode,
} from '@geo-content-os/contracts';

import type { DatabaseClient } from '../../../database/index.js';
import type {
  ContentBlockType,
  ContentDocument,
  GenerationMode,
  GenerationRunStatus,
} from '../../../database/schema/index.js';

export interface ContentScope {
  readonly projectId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface BriefRecordView {
  readonly audience: string;
  readonly constraints: BriefConstraints;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly deletedAt: Date | null;
  readonly dueAt: Date | null;
  readonly generationMode: GenerationMode;
  readonly id: string;
  readonly objective: 'awareness' | 'conversion' | 'trust' | 'education';
  readonly platformCodes: readonly PlatformCode[];
  readonly projectId: string;
  readonly sourceTopicCandidateId: string | null;
  readonly tenantId: string;
  readonly title: string;
  readonly updatedAt: Date;
  readonly version: number;
  readonly workspaceId: string;
}

export interface ContentPackageView {
  readonly briefId: string;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly deletedAt: Date | null;
  readonly id: string;
  readonly masterContentVersionId: string | null;
  readonly projectId: string;
  readonly status: ContentPackageStatus;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly version: number;
  readonly workspaceId: string;
}

export interface ContentVariantView {
  readonly createdAt: Date;
  readonly currentContentVersionId: string | null;
  readonly id: string;
  readonly isRequired: boolean;
  readonly packageId: string;
  readonly platformCode: PlatformCode;
  readonly qualityScore: string | null;
  readonly status: ContentVariantStatus;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface ContentVersionView {
  readonly contentHash: string;
  readonly contentJson: ContentDocument;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly id: string;
  readonly packageId: string;
  readonly schemaVersion: string;
  readonly sourceRunId: string | null;
  readonly tenantId: string;
  readonly variantId: string | null;
  readonly versionNo: number;
}

export interface ContentBlockView {
  readonly blockKey: string;
  readonly blockType: ContentBlockType;
  readonly contentVersionId: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly position: number;
  readonly tenantId: string;
  readonly textHash: string;
}

export interface ContentBlockLockView {
  readonly blockKey: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly lockedBy: string;
  readonly lockedContentHash: string;
  readonly reason: string | null;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly variantId: string;
}

export interface AiCitationView {
  readonly chunkId: string;
  readonly claimKey: string;
  readonly claimText: string;
  readonly contentVersionId: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly quoteHash: string;
  readonly quoteText: string;
  readonly tenantId: string;
}

export interface ContentGenerationRunView {
  readonly createdAt: Date;
  readonly error: Record<string, unknown> | null;
  readonly finishedAt: Date | null;
  readonly id: string;
  readonly inputHash: string;
  readonly modelKey: string;
  readonly packageId: string | null;
  readonly projectId: string | null;
  readonly promptVersionId: string;
  readonly requestId: string;
  readonly skillName: string;
  readonly skillVersion: string;
  readonly startedAt: Date | null;
  readonly status: GenerationRunStatus;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly variantId: string | null;
  readonly version: number;
  readonly workspaceId: string;
}

/** Every read is tenant/workspace/project/user scoped and returns no cross-scope existence signal. */
export class ContentRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async findBrief(scope: ContentScope, id: string): Promise<BriefRecordView | undefined> {
    const rows = await this.client<BriefRecordView[]>`
      SELECT
        brief.id,
        brief.tenant_id AS "tenantId",
        brief.workspace_id AS "workspaceId",
        brief.project_id AS "projectId",
        brief.source_topic_candidate_id AS "sourceTopicCandidateId",
        brief.title,
        brief.objective,
        brief.audience,
        brief.platform_codes AS "platformCodes",
        brief.constraints_json AS constraints,
        brief.generation_mode AS "generationMode",
        brief.due_at AS "dueAt",
        brief.created_by AS "createdBy",
        brief.version,
        brief.created_at AS "createdAt",
        brief.updated_at AS "updatedAt",
        brief.deleted_at AS "deletedAt"
      FROM briefs AS brief
      WHERE brief.tenant_id = ${scope.tenantId}::uuid
        AND brief.workspace_id = ${scope.workspaceId}::uuid
        AND brief.project_id = ${scope.projectId}::uuid
        AND has_project_scope_access(brief.tenant_id, brief.workspace_id, brief.project_id, ${scope.userId}::uuid)
        AND brief.id = ${id}::uuid
        AND brief.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async listBriefs(scope: ContentScope): Promise<readonly BriefRecordView[]> {
    return this.client<BriefRecordView[]>`
      SELECT
        brief.id,
        brief.tenant_id AS "tenantId",
        brief.workspace_id AS "workspaceId",
        brief.project_id AS "projectId",
        brief.source_topic_candidate_id AS "sourceTopicCandidateId",
        brief.title,
        brief.objective,
        brief.audience,
        brief.platform_codes AS "platformCodes",
        brief.constraints_json AS constraints,
        brief.generation_mode AS "generationMode",
        brief.due_at AS "dueAt",
        brief.created_by AS "createdBy",
        brief.version,
        brief.created_at AS "createdAt",
        brief.updated_at AS "updatedAt",
        brief.deleted_at AS "deletedAt"
      FROM briefs AS brief
      WHERE brief.tenant_id = ${scope.tenantId}::uuid
        AND brief.workspace_id = ${scope.workspaceId}::uuid
        AND brief.project_id = ${scope.projectId}::uuid
        AND has_project_scope_access(brief.tenant_id, brief.workspace_id, brief.project_id, ${scope.userId}::uuid)
        AND brief.deleted_at IS NULL
      ORDER BY brief.updated_at DESC, brief.id
    `;
  }

  public async findPackage(
    scope: ContentScope,
    id: string,
  ): Promise<ContentPackageView | undefined> {
    const rows = await this.client<ContentPackageView[]>`
      SELECT
        package.id,
        package.tenant_id AS "tenantId",
        package.workspace_id AS "workspaceId",
        package.project_id AS "projectId",
        package.brief_id AS "briefId",
        package.status,
        package.version,
        package.master_content_version_id AS "masterContentVersionId",
        package.created_by AS "createdBy",
        package.created_at AS "createdAt",
        package.updated_at AS "updatedAt",
        package.deleted_at AS "deletedAt"
      FROM content_packages AS package
      WHERE package.tenant_id = ${scope.tenantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
        AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid)
        AND package.id = ${id}::uuid
        AND package.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async listPackages(scope: ContentScope): Promise<readonly ContentPackageView[]> {
    return this.client<ContentPackageView[]>`
      SELECT
        package.id,
        package.tenant_id AS "tenantId",
        package.workspace_id AS "workspaceId",
        package.project_id AS "projectId",
        package.brief_id AS "briefId",
        package.status,
        package.version,
        package.master_content_version_id AS "masterContentVersionId",
        package.created_by AS "createdBy",
        package.created_at AS "createdAt",
        package.updated_at AS "updatedAt",
        package.deleted_at AS "deletedAt"
      FROM content_packages AS package
      WHERE package.tenant_id = ${scope.tenantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
        AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid)
        AND package.deleted_at IS NULL
      ORDER BY package.updated_at DESC, package.id
    `;
  }

  public async listVariants(
    scope: ContentScope,
    packageId: string,
  ): Promise<readonly ContentVariantView[]> {
    return this.client<ContentVariantView[]>`
      SELECT
        variant.id,
        variant.tenant_id AS "tenantId",
        variant.package_id AS "packageId",
        variant.platform_code AS "platformCode",
        variant.current_content_version_id AS "currentContentVersionId",
        variant.status,
        variant.is_required AS "isRequired",
        variant.quality_score::text AS "qualityScore",
        variant.version,
        variant.created_at AS "createdAt",
        variant.updated_at AS "updatedAt"
      FROM content_variants AS variant
      JOIN content_packages AS package
        ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
      WHERE package.tenant_id = ${scope.tenantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
        AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid)
        AND package.id = ${packageId}::uuid
        AND package.deleted_at IS NULL
      ORDER BY variant.platform_code, variant.id
    `;
  }

  public async findVersion(
    scope: ContentScope,
    id: string,
  ): Promise<ContentVersionView | undefined> {
    const rows = await this.client<ContentVersionView[]>`
      SELECT
        version.id,
        version.tenant_id AS "tenantId",
        version.package_id AS "packageId",
        version.variant_id AS "variantId",
        version.version_no AS "versionNo",
        version.schema_version AS "schemaVersion",
        version.content_json AS "contentJson",
        version.content_hash AS "contentHash",
        version.source_run_id AS "sourceRunId",
        version.created_by AS "createdBy",
        version.created_at AS "createdAt"
      FROM content_versions AS version
      JOIN content_packages AS package
        ON package.id = version.package_id AND package.tenant_id = version.tenant_id
      WHERE package.tenant_id = ${scope.tenantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
        AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid)
        AND version.id = ${id}::uuid
        AND package.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async listVersions(
    scope: ContentScope,
    packageId: string,
    variantId: string | null,
  ): Promise<readonly ContentVersionView[]> {
    return this.client<ContentVersionView[]>`
      SELECT
        version.id,
        version.tenant_id AS "tenantId",
        version.package_id AS "packageId",
        version.variant_id AS "variantId",
        version.version_no AS "versionNo",
        version.schema_version AS "schemaVersion",
        version.content_json AS "contentJson",
        version.content_hash AS "contentHash",
        version.source_run_id AS "sourceRunId",
        version.created_by AS "createdBy",
        version.created_at AS "createdAt"
      FROM content_versions AS version
      JOIN content_packages AS package
        ON package.id = version.package_id AND package.tenant_id = version.tenant_id
      WHERE package.tenant_id = ${scope.tenantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
        AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid)
        AND package.id = ${packageId}::uuid
        AND version.variant_id IS NOT DISTINCT FROM ${variantId}::uuid
        AND package.deleted_at IS NULL
      ORDER BY version.version_no DESC, version.id
    `;
  }

  public async listBlocks(
    scope: ContentScope,
    contentVersionId: string,
  ): Promise<readonly ContentBlockView[]> {
    return this.client<ContentBlockView[]>`
      SELECT
        block.id,
        block.tenant_id AS "tenantId",
        block.content_version_id AS "contentVersionId",
        block.block_key AS "blockKey",
        block.block_type AS "blockType",
        block.position,
        block.text_hash AS "textHash",
        block.created_at AS "createdAt"
      FROM content_blocks AS block
      JOIN content_versions AS version
        ON version.id = block.content_version_id AND version.tenant_id = block.tenant_id
      JOIN content_packages AS package
        ON package.id = version.package_id AND package.tenant_id = version.tenant_id
      WHERE package.tenant_id = ${scope.tenantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
        AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid)
        AND version.id = ${contentVersionId}::uuid
        AND package.deleted_at IS NULL
      ORDER BY block.position, block.id
    `;
  }

  public async listBlockLocks(
    scope: ContentScope,
    variantId: string,
  ): Promise<readonly ContentBlockLockView[]> {
    return this.client<ContentBlockLockView[]>`
      SELECT
        lock.id,
        lock.tenant_id AS "tenantId",
        lock.variant_id AS "variantId",
        lock.block_key AS "blockKey",
        lock.locked_content_hash AS "lockedContentHash",
        lock.locked_by AS "lockedBy",
        lock.reason,
        lock.created_at AS "createdAt",
        lock.updated_at AS "updatedAt"
      FROM content_block_locks AS lock
      JOIN content_variants AS variant
        ON variant.id = lock.variant_id AND variant.tenant_id = lock.tenant_id
      JOIN content_packages AS package
        ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
      WHERE package.tenant_id = ${scope.tenantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
        AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid)
        AND variant.id = ${variantId}::uuid
        AND package.deleted_at IS NULL
      ORDER BY lock.block_key, lock.id
    `;
  }

  public async listCitations(
    scope: ContentScope,
    contentVersionId: string,
  ): Promise<readonly AiCitationView[]> {
    return this.client<AiCitationView[]>`
      SELECT
        citation.id,
        citation.tenant_id AS "tenantId",
        citation.content_version_id AS "contentVersionId",
        citation.claim_key AS "claimKey",
        citation.claim_text AS "claimText",
        citation.chunk_id AS "chunkId",
        citation.quote_text AS "quoteText",
        citation.quote_hash AS "quoteHash",
        citation.created_at AS "createdAt"
      FROM ai_citations AS citation
      JOIN content_versions AS version
        ON version.id = citation.content_version_id AND version.tenant_id = citation.tenant_id
      JOIN content_packages AS package
        ON package.id = version.package_id AND package.tenant_id = version.tenant_id
      WHERE package.tenant_id = ${scope.tenantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
        AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid)
        AND version.id = ${contentVersionId}::uuid
        AND package.deleted_at IS NULL
      ORDER BY citation.claim_key, citation.created_at, citation.id
    `;
  }

  public async listRuns(
    scope: ContentScope,
    packageId: string,
  ): Promise<readonly ContentGenerationRunView[]> {
    return this.client<ContentGenerationRunView[]>`
      SELECT
        run.id,
        run.tenant_id AS "tenantId",
        run.workspace_id AS "workspaceId",
        run.project_id AS "projectId",
        run.package_id AS "packageId",
        run.variant_id AS "variantId",
        run.skill_name AS "skillName",
        run.skill_version AS "skillVersion",
        run.prompt_version_id AS "promptVersionId",
        run.model_key AS "modelKey",
        run.status,
        run.input_hash AS "inputHash",
        run.request_id AS "requestId",
        run.error_json AS error,
        run.started_at AS "startedAt",
        run.finished_at AS "finishedAt",
        run.version,
        run.created_at AS "createdAt",
        run.updated_at AS "updatedAt"
      FROM generation_runs AS run
      JOIN content_packages AS package
        ON package.id = run.package_id AND package.tenant_id = run.tenant_id
      WHERE package.tenant_id = ${scope.tenantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
        AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid)
        AND package.id = ${packageId}::uuid
        AND package.deleted_at IS NULL
      ORDER BY run.created_at DESC, run.id
    `;
  }
}
