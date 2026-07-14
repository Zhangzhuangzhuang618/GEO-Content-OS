import type { BrandProfile, PlatformCode } from '@geo-content-os/contracts';

import type { DatabaseClient } from '../../../database/index.js';
import type {
  BrandProfileStatus,
  CitationSet,
  EntityList,
  KeywordIntent,
  KeywordStatus,
  ProjectStatus,
  TopicCandidateStatus,
  TopicRiskLevel,
  WorkspaceSettings,
  WorkspaceStatus,
} from '../../../database/schema/index.js';

export interface WorkspaceView {
  readonly createdAt: Date;
  readonly id: string;
  readonly name: string;
  readonly settings: WorkspaceSettings;
  readonly slug: string;
  readonly status: WorkspaceStatus;
  readonly tenantId: string;
  readonly timezone: string;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface ProjectView {
  readonly createdAt: Date;
  readonly endDate: string | null;
  readonly id: string;
  readonly name: string;
  readonly objective: string | null;
  readonly ownerId: string;
  readonly startDate: string | null;
  readonly status: ProjectStatus;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly version: number;
  readonly workspaceId: string;
}

export interface BrandProfileView {
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly id: string;
  readonly profile: BrandProfile;
  readonly publishedAt: Date | null;
  readonly schemaVersion: 'brand-profile@1';
  readonly status: BrandProfileStatus;
  readonly tenantId: string;
  readonly version: number;
  readonly workspaceId: string;
}

export interface KeywordSetView {
  readonly createdAt: Date;
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly status: 'active' | 'archived';
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface KeywordView {
  readonly id: string;
  readonly intent: KeywordIntent;
  readonly keywordSetId: string;
  readonly platformScope: readonly PlatformCode[];
  readonly priority: number;
  readonly status: KeywordStatus;
  readonly synonyms: readonly string[];
  readonly tenantId: string;
  readonly term: string;
  readonly updatedAt: Date;
}

export interface TopicCandidateView {
  readonly createdAt: Date;
  readonly entities: EntityList;
  readonly evidenceSummary: CitationSet;
  readonly generationRunId: string;
  readonly id: string;
  readonly intent: string;
  readonly platformCodes: readonly PlatformCode[];
  readonly priority: number;
  readonly projectId: string;
  readonly question: string;
  readonly riskLevel: TopicRiskLevel;
  readonly status: TopicCandidateStatus;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly workspaceId: string;
}

/**
 * All resource reads require tenant_id in the SQL predicate. Callers cannot accidentally use an
 * object UUID as a global identifier, and soft-deleted parents are hidden by default.
 */
export class WorkspaceStrategyRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async findWorkspace(
    tenantId: string,
    workspaceId: string,
  ): Promise<WorkspaceView | undefined> {
    const rows = await this.client<WorkspaceView[]>`
      SELECT
        workspace.id,
        workspace.tenant_id AS "tenantId",
        workspace.name,
        workspace.slug::text AS slug,
        workspace.timezone,
        workspace.settings_json AS settings,
        workspace.status,
        workspace.version,
        workspace.created_at AS "createdAt",
        workspace.updated_at AS "updatedAt"
      FROM workspaces AS workspace
      WHERE
        workspace.id = ${workspaceId}
        AND workspace.tenant_id = ${tenantId}
        AND workspace.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async listWorkspaces(tenantId: string): Promise<readonly WorkspaceView[]> {
    return this.client<WorkspaceView[]>`
      SELECT
        id,
        tenant_id AS "tenantId",
        name,
        slug::text AS slug,
        timezone,
        settings_json AS settings,
        status,
        version,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM workspaces
      WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
      ORDER BY updated_at DESC, id
    `;
  }

  public async findProject(tenantId: string, projectId: string): Promise<ProjectView | undefined> {
    const rows = await this.client<ProjectView[]>`
      SELECT
        project.id,
        project.tenant_id AS "tenantId",
        project.workspace_id AS "workspaceId",
        project.name,
        project.owner_id AS "ownerId",
        project.objective,
        project.status,
        project.version,
        project.start_date::text AS "startDate",
        project.end_date::text AS "endDate",
        project.created_at AS "createdAt",
        project.updated_at AS "updatedAt"
      FROM projects AS project
      JOIN workspaces AS workspace
        ON workspace.id = project.workspace_id
        AND workspace.tenant_id = project.tenant_id
      WHERE
        project.id = ${projectId}
        AND project.tenant_id = ${tenantId}
        AND project.deleted_at IS NULL
        AND workspace.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async listProjects(
    tenantId: string,
    workspaceId: string,
  ): Promise<readonly ProjectView[]> {
    return this.client<ProjectView[]>`
      SELECT
        project.id,
        project.tenant_id AS "tenantId",
        project.workspace_id AS "workspaceId",
        project.name,
        project.owner_id AS "ownerId",
        project.objective,
        project.status,
        project.version,
        project.start_date::text AS "startDate",
        project.end_date::text AS "endDate",
        project.created_at AS "createdAt",
        project.updated_at AS "updatedAt"
      FROM projects AS project
      JOIN workspaces AS workspace
        ON workspace.id = project.workspace_id
        AND workspace.tenant_id = project.tenant_id
      WHERE
        project.tenant_id = ${tenantId}
        AND project.workspace_id = ${workspaceId}
        AND project.deleted_at IS NULL
        AND workspace.deleted_at IS NULL
      ORDER BY project.updated_at DESC, project.id
    `;
  }

  public async findBrandProfile(
    tenantId: string,
    brandProfileId: string,
  ): Promise<BrandProfileView | undefined> {
    const rows = await this.client<BrandProfileView[]>`
      SELECT
        profile.id,
        profile.tenant_id AS "tenantId",
        profile.workspace_id AS "workspaceId",
        profile.version,
        profile.status,
        profile.schema_version AS "schemaVersion",
        profile.profile_json AS profile,
        profile.created_by AS "createdBy",
        profile.published_at AS "publishedAt",
        profile.created_at AS "createdAt"
      FROM brand_profiles AS profile
      JOIN workspaces AS workspace
        ON workspace.id = profile.workspace_id
        AND workspace.tenant_id = profile.tenant_id
      WHERE
        profile.id = ${brandProfileId}
        AND profile.tenant_id = ${tenantId}
        AND workspace.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async listBrandProfiles(
    tenantId: string,
    workspaceId: string,
  ): Promise<readonly BrandProfileView[]> {
    return this.client<BrandProfileView[]>`
      SELECT
        profile.id,
        profile.tenant_id AS "tenantId",
        profile.workspace_id AS "workspaceId",
        profile.version,
        profile.status,
        profile.schema_version AS "schemaVersion",
        profile.profile_json AS profile,
        profile.created_by AS "createdBy",
        profile.published_at AS "publishedAt",
        profile.created_at AS "createdAt"
      FROM brand_profiles AS profile
      JOIN workspaces AS workspace
        ON workspace.id = profile.workspace_id
        AND workspace.tenant_id = profile.tenant_id
      WHERE
        profile.tenant_id = ${tenantId}
        AND profile.workspace_id = ${workspaceId}
        AND workspace.deleted_at IS NULL
      ORDER BY profile.version DESC, profile.id
    `;
  }

  public async findKeywordSet(
    tenantId: string,
    keywordSetId: string,
  ): Promise<KeywordSetView | undefined> {
    const rows = await this.client<KeywordSetView[]>`
      SELECT
        keyword_set.id,
        keyword_set.tenant_id AS "tenantId",
        keyword_set.project_id AS "projectId",
        keyword_set.name,
        keyword_set.status,
        keyword_set.created_at AS "createdAt",
        keyword_set.updated_at AS "updatedAt"
      FROM keyword_sets AS keyword_set
      JOIN projects AS project
        ON project.id = keyword_set.project_id
        AND project.tenant_id = keyword_set.tenant_id
      JOIN workspaces AS workspace
        ON workspace.id = project.workspace_id
        AND workspace.tenant_id = project.tenant_id
      WHERE
        keyword_set.id = ${keywordSetId}
        AND keyword_set.tenant_id = ${tenantId}
        AND keyword_set.deleted_at IS NULL
        AND project.deleted_at IS NULL
        AND workspace.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async listKeywords(
    tenantId: string,
    keywordSetId: string,
  ): Promise<readonly KeywordView[]> {
    return this.client<KeywordView[]>`
      SELECT
        keyword.id,
        keyword.tenant_id AS "tenantId",
        keyword.keyword_set_id AS "keywordSetId",
        keyword.term::text AS term,
        keyword.intent,
        keyword.priority,
        keyword.synonyms,
        keyword.platform_scope AS "platformScope",
        keyword.status,
        keyword.updated_at AS "updatedAt"
      FROM keywords AS keyword
      JOIN keyword_sets AS keyword_set
        ON keyword_set.id = keyword.keyword_set_id
        AND keyword_set.tenant_id = keyword.tenant_id
      JOIN projects AS project
        ON project.id = keyword_set.project_id
        AND project.tenant_id = keyword_set.tenant_id
      JOIN workspaces AS workspace
        ON workspace.id = project.workspace_id
        AND workspace.tenant_id = project.tenant_id
      WHERE
        keyword.tenant_id = ${tenantId}
        AND keyword.keyword_set_id = ${keywordSetId}
        AND keyword_set.deleted_at IS NULL
        AND project.deleted_at IS NULL
        AND workspace.deleted_at IS NULL
      ORDER BY keyword.priority DESC, keyword.term, keyword.id
    `;
  }

  public async findTopicCandidate(
    tenantId: string,
    topicCandidateId: string,
  ): Promise<TopicCandidateView | undefined> {
    const rows = await this.client<TopicCandidateView[]>`
      SELECT
        topic.id,
        topic.tenant_id AS "tenantId",
        topic.workspace_id AS "workspaceId",
        topic.project_id AS "projectId",
        topic.generation_run_id AS "generationRunId",
        topic.question,
        topic.intent,
        topic.entities_json AS entities,
        topic.evidence_summary_json AS "evidenceSummary",
        topic.platform_codes AS "platformCodes",
        topic.priority,
        topic.risk_level AS "riskLevel",
        topic.status,
        topic.created_at AS "createdAt",
        topic.updated_at AS "updatedAt"
      FROM topic_candidates AS topic
      JOIN projects AS project
        ON project.id = topic.project_id
        AND project.tenant_id = topic.tenant_id
        AND project.workspace_id = topic.workspace_id
      JOIN workspaces AS workspace
        ON workspace.id = topic.workspace_id
        AND workspace.tenant_id = topic.tenant_id
      WHERE
        topic.id = ${topicCandidateId}
        AND topic.tenant_id = ${tenantId}
        AND project.deleted_at IS NULL
        AND workspace.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async listTopicCandidates(
    tenantId: string,
    workspaceId: string,
    projectId: string,
  ): Promise<readonly TopicCandidateView[]> {
    return this.client<TopicCandidateView[]>`
      SELECT
        topic.id,
        topic.tenant_id AS "tenantId",
        topic.workspace_id AS "workspaceId",
        topic.project_id AS "projectId",
        topic.generation_run_id AS "generationRunId",
        topic.question,
        topic.intent,
        topic.entities_json AS entities,
        topic.evidence_summary_json AS "evidenceSummary",
        topic.platform_codes AS "platformCodes",
        topic.priority,
        topic.risk_level AS "riskLevel",
        topic.status,
        topic.created_at AS "createdAt",
        topic.updated_at AS "updatedAt"
      FROM topic_candidates AS topic
      JOIN projects AS project
        ON project.id = topic.project_id
        AND project.tenant_id = topic.tenant_id
        AND project.workspace_id = topic.workspace_id
      JOIN workspaces AS workspace
        ON workspace.id = topic.workspace_id
        AND workspace.tenant_id = topic.tenant_id
      WHERE
        topic.tenant_id = ${tenantId}
        AND topic.workspace_id = ${workspaceId}
        AND topic.project_id = ${projectId}
        AND project.deleted_at IS NULL
        AND workspace.deleted_at IS NULL
      ORDER BY topic.priority DESC, topic.created_at DESC, topic.id
    `;
  }
}
