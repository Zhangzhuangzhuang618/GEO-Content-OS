import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { WorkspaceStrategyRepository } from '../../src/modules/workspace/index.js';

const TENANT_A = '20000000-0000-4000-8000-000000000021';
const TENANT_B = '20000000-0000-4000-8000-000000000121';
const USER_A = '10000000-0000-4000-8000-000000000021';
const USER_B = '10000000-0000-4000-8000-000000000121';
const WORKSPACE_A = '30000000-0000-4000-8000-000000000021';
const WORKSPACE_B = '30000000-0000-4000-8000-000000000121';
const PROJECT_A = '40000000-0000-4000-8000-000000000021';
const PROJECT_B = '40000000-0000-4000-8000-000000000121';
const PROMPT_VERSION = '50000000-0000-4000-8000-000000000021';

describe('workspace and strategy database', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 3 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await database`
      INSERT INTO users (id, email, display_name, status)
      VALUES
        (${USER_A}, 'workspace-a@example.com', 'Workspace A User', 'active'),
        (${USER_B}, 'workspace-b@example.com', 'Workspace B User', 'active')
    `;
    await database`
      INSERT INTO tenants (id, name, slug, status)
      VALUES
        (${TENANT_A}, 'Tenant A', 'workspace-tenant-a', 'active'),
        (${TENANT_B}, 'Tenant B', 'workspace-tenant-b', 'active')
    `;
    await database`
      INSERT INTO memberships (tenant_id, user_id, role_code, status)
      VALUES
        (${TENANT_A}, ${USER_A}, 'tenant_owner', 'active'),
        (${TENANT_B}, ${USER_B}, 'tenant_owner', 'active')
    `;
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('enforces workspace uniqueness, JSON shape, membership tenant, and update timestamps', async () => {
    const database = requireClient(client);
    await insertWorkspace(database, TENANT_A, WORKSPACE_A, 'strategy');
    await expect(insertWorkspace(database, TENANT_A, undefined, 'strategy')).rejects.toThrow(
      /workspaces_tenant_slug_active_uq/u,
    );
    await expect(
      database`
        INSERT INTO workspaces (tenant_id, name, slug, timezone, settings_json)
        VALUES (${TENANT_A}, 'Bad settings', 'bad-settings', 'Asia/Shanghai', '[]'::jsonb)
      `,
    ).rejects.toThrow(/workspaces_settings_check/u);
    await expect(
      database`
        INSERT INTO workspace_memberships (workspace_id, user_id)
        VALUES (${WORKSPACE_A}, ${USER_B})
      `,
    ).rejects.toThrow(/must belong to the workspace tenant/u);
    await database`
      INSERT INTO workspace_memberships (workspace_id, user_id)
      VALUES (${WORKSPACE_A}, ${USER_A})
    `;

    await database`
      UPDATE workspaces
      SET name = 'Updated strategy', updated_at = '2000-01-01T00:00:00Z'
      WHERE id = ${WORKSPACE_A}
    `;
    const after = await database<{ updatedAt: Date }[]>`
      SELECT updated_at AS "updatedAt" FROM workspaces WHERE id = ${WORKSPACE_A}
    `;
    expect(after[0]?.updatedAt.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('prevents cross-tenant workspace, project, and owner associations', async () => {
    const database = requireClient(client);
    await insertWorkspace(database, TENANT_A, WORKSPACE_A, 'tenant-a');
    await insertWorkspace(database, TENANT_B, WORKSPACE_B, 'tenant-b');
    await expect(
      database`
        INSERT INTO projects (tenant_id, workspace_id, name, owner_id)
        VALUES (${TENANT_A}, ${WORKSPACE_B}, 'Forged workspace', ${USER_A})
      `,
    ).rejects.toThrow(/projects_workspace_fk/u);
    await expect(
      database`
        INSERT INTO projects (tenant_id, workspace_id, name, owner_id)
        VALUES (${TENANT_A}, ${WORKSPACE_A}, 'Forged owner', ${USER_B})
      `,
    ).rejects.toThrow(/projects_owner_membership_fk/u);
    await insertProject(database, TENANT_A, WORKSPACE_A, PROJECT_A, USER_A);
    await expect(
      database`
        INSERT INTO keyword_sets (tenant_id, project_id, name)
        VALUES (${TENANT_B}, ${PROJECT_A}, 'Forged project')
      `,
    ).rejects.toThrow(/keyword_sets_project_fk/u);
  });

  it('keeps brand versions immutable and allows only one published version', async () => {
    const database = requireClient(client);
    await insertWorkspace(database, TENANT_A, WORKSPACE_A, 'brand');
    await expect(
      database`
        INSERT INTO brand_profiles (
          tenant_id, workspace_id, version, schema_version, profile_json, created_by
        ) VALUES (
          ${TENANT_A}, ${WORKSPACE_A}, 99, 'brand-profile@1', '{}', ${USER_B}
        )
      `,
    ).rejects.toThrow(/brand_profiles_created_by_membership_fk/u);
    const first = await insertBrandProfile(database, 1);
    const second = await insertBrandProfile(database, 2);
    await expect(
      database`
        UPDATE brand_profiles SET profile_json = '{"positioning":"changed"}'::jsonb
        WHERE id = ${first}
      `,
    ).rejects.toThrow(/content is immutable/u);
    await database`
      UPDATE brand_profiles SET status = 'published', published_at = now() WHERE id = ${first}
    `;
    await expect(
      database`
        UPDATE brand_profiles SET status = 'published', published_at = now() WHERE id = ${second}
      `,
    ).rejects.toThrow(/brand_profiles_one_published_uq/u);
    await database`UPDATE brand_profiles SET status = 'retired' WHERE id = ${first}`;
    await database`
      UPDATE brand_profiles SET status = 'published', published_at = now() WHERE id = ${second}
    `;
    await expect(
      database`
        UPDATE brand_profiles SET status = 'draft', published_at = NULL WHERE id = ${second}
      `,
    ).rejects.toThrow(/invalid brand profile status transition/u);
    const repository = new WorkspaceStrategyRepository(database);
    expect(await repository.findBrandProfile(TENANT_A, second)).toMatchObject({
      id: second,
      status: 'published',
      version: 2,
    });
    expect(await repository.findBrandProfile(TENANT_B, second)).toBeUndefined();
    expect(await repository.listBrandProfiles(TENANT_A, WORKSPACE_A)).toHaveLength(2);
  });

  it('validates keyword arrays, platform codes, priority, and case-insensitive uniqueness', async () => {
    const database = requireClient(client);
    await insertWorkspace(database, TENANT_A, WORKSPACE_A, 'keywords');
    await insertProject(database, TENANT_A, WORKSPACE_A, PROJECT_A, USER_A);
    const keywordSet = await insertKeywordSet(database);
    await insertKeyword(database, keywordSet, 'GEO Content', ['zhihu', 'official_site']);
    await expect(insertKeyword(database, keywordSet, 'geo content', ['douyin'])).rejects.toThrow(
      /keywords_set_term_uq/u,
    );
    await expect(
      insertKeyword(database, keywordSet, 'Duplicate platform', ['zhihu', 'zhihu']),
    ).rejects.toThrow(/keywords_platform_scope_check/u);
    await expect(
      insertKeyword(database, keywordSet, 'Unknown platform', ['unknown']),
    ).rejects.toThrow(/keywords_platform_scope_check/u);
    await expect(
      database`
        INSERT INTO keywords (
          tenant_id, keyword_set_id, term, intent, priority, synonyms, platform_scope
        ) VALUES (
          ${TENANT_A}, ${keywordSet}, 'Duplicate synonym', 'informational', 50,
          ARRAY['GEO', 'geo'], ARRAY['zhihu']
        )
      `,
    ).rejects.toThrow(/keywords_synonyms_check/u);
    await expect(
      database`
        INSERT INTO keywords (
          tenant_id, keyword_set_id, term, intent, priority, platform_scope
        ) VALUES (
          ${TENANT_A}, ${keywordSet}, 'Bad priority', 'informational', 101,
          ARRAY['zhihu']
        )
      `,
    ).rejects.toThrow(/keywords_priority_check/u);
    const repository = new WorkspaceStrategyRepository(database);
    expect(await repository.findKeywordSet(TENANT_A, keywordSet)).toMatchObject({
      id: keywordSet,
      tenantId: TENANT_A,
    });
    expect(await repository.findKeywordSet(TENANT_B, keywordSet)).toBeUndefined();
    expect(await repository.listKeywords(TENANT_A, keywordSet)).toMatchObject([
      { platformScope: ['zhihu', 'official_site'], term: 'GEO Content' },
    ]);
  });

  it('binds topics to one tenant/project/run, guards source history, and isolates repository reads', async () => {
    const database = requireClient(client);
    await insertWorkspace(database, TENANT_A, WORKSPACE_A, 'topics-a');
    await insertWorkspace(database, TENANT_B, WORKSPACE_B, 'topics-b');
    await insertProject(database, TENANT_A, WORKSPACE_A, PROJECT_A, USER_A);
    await insertProject(database, TENANT_B, WORKSPACE_B, PROJECT_B, USER_B);
    const runA = await insertGenerationRun(database, TENANT_A, WORKSPACE_A, PROJECT_A);
    const runB = await insertGenerationRun(database, TENANT_B, WORKSPACE_B, PROJECT_B);
    const topicId = await insertTopic(database, runA);
    await expect(insertTopic(database, runB)).rejects.toThrow(
      /topic_candidates_generation_run_fk/u,
    );
    await expect(
      database`
        INSERT INTO topic_candidates (
          tenant_id, workspace_id, project_id, generation_run_id, question, intent,
          entities_json, evidence_summary_json, platform_codes, priority, risk_level
        ) VALUES (
          ${TENANT_A}, ${WORKSPACE_A}, ${PROJECT_A}, ${runA}, 'Invalid entities?',
          'informational', '{}', ${JSON.stringify(citations())}::text::jsonb,
          ARRAY['zhihu'], 50, 'low'
        )
      `,
    ).rejects.toThrow(/topic_candidates_entities_check/u);
    await expect(
      database`UPDATE topic_candidates SET question = 'Changed source?' WHERE id = ${topicId}`,
    ).rejects.toThrow(/source is immutable/u);
    await database`UPDATE topic_candidates SET status = 'adopted' WHERE id = ${topicId}`;
    await expect(
      database`UPDATE topic_candidates SET status = 'archived' WHERE id = ${topicId}`,
    ).rejects.toThrow(/invalid topic candidate status transition/u);

    const repository = new WorkspaceStrategyRepository(database);
    expect(await repository.findWorkspace(TENANT_A, WORKSPACE_A)).toMatchObject({
      id: WORKSPACE_A,
      tenantId: TENANT_A,
    });
    expect(await repository.findWorkspace(TENANT_B, WORKSPACE_A)).toBeUndefined();
    expect(await repository.findProject(TENANT_B, PROJECT_A)).toBeUndefined();
    expect(await repository.findTopicCandidate(TENANT_B, topicId)).toBeUndefined();
    expect(await repository.findTopicCandidate(TENANT_A, topicId)).toMatchObject({
      id: topicId,
      status: 'adopted',
      tenantId: TENANT_A,
    });
    expect(await repository.listWorkspaces(TENANT_A)).toHaveLength(1);
    expect(await repository.listProjects(TENANT_A, WORKSPACE_A)).toHaveLength(1);
    expect(await repository.listTopicCandidates(TENANT_A, WORKSPACE_A, PROJECT_A)).toHaveLength(1);

    await database`
      UPDATE workspaces SET status = 'archived', deleted_at = now() WHERE id = ${WORKSPACE_A}
    `;
    expect(await repository.findWorkspace(TENANT_A, WORKSPACE_A)).toBeUndefined();
    expect(await repository.findProject(TENANT_A, PROJECT_A)).toBeUndefined();
    expect(await repository.findTopicCandidate(TENANT_A, topicId)).toBeUndefined();
  });
});

async function insertWorkspace(
  database: Sql,
  tenantId: string,
  id: string | undefined,
  slug: string,
): Promise<string> {
  const rows = id
    ? await database<{ id: string }[]>`
        INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
        VALUES (${id}, ${tenantId}, ${`Workspace ${slug}`}, ${slug}, 'Asia/Shanghai')
        RETURNING id
      `
    : await database<{ id: string }[]>`
        INSERT INTO workspaces (tenant_id, name, slug, timezone)
        VALUES (${tenantId}, ${`Workspace ${slug}`}, ${slug}, 'Asia/Shanghai')
        RETURNING id
      `;
  const workspace = rows[0];
  if (!workspace) throw new Error('Expected workspace fixture');
  return workspace.id;
}

async function insertProject(
  database: Sql,
  tenantId: string,
  workspaceId: string,
  projectId: string,
  ownerId: string,
): Promise<void> {
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES (${projectId}, ${tenantId}, ${workspaceId}, 'Project fixture', ${ownerId})
  `;
}

async function insertBrandProfile(database: Sql, version: number): Promise<string> {
  const rows = await database<{ id: string }[]>`
    INSERT INTO brand_profiles (
      tenant_id, workspace_id, version, schema_version, profile_json, created_by
    ) VALUES (
      ${TENANT_A}, ${WORKSPACE_A}, ${version}, 'brand-profile@1',
      ${JSON.stringify({ positioning: `version-${version}` })}::text::jsonb, ${USER_A}
    )
    RETURNING id
  `;
  const profile = rows[0];
  if (!profile) throw new Error('Expected brand profile fixture');
  return profile.id;
}

async function insertKeywordSet(database: Sql): Promise<string> {
  const rows = await database<{ id: string }[]>`
    INSERT INTO keyword_sets (tenant_id, project_id, name)
    VALUES (${TENANT_A}, ${PROJECT_A}, 'Core keywords')
    RETURNING id
  `;
  const keywordSet = rows[0];
  if (!keywordSet) throw new Error('Expected keyword set fixture');
  return keywordSet.id;
}

async function insertKeyword(
  database: Sql,
  keywordSetId: string,
  term: string,
  platformScope: readonly string[],
): Promise<void> {
  await database`
    INSERT INTO keywords (
      tenant_id, keyword_set_id, term, intent, priority, platform_scope
    ) VALUES (
      ${TENANT_A}, ${keywordSetId}, ${term}, 'informational', 50, ${platformScope}
    )
  `;
}

async function insertGenerationRun(
  database: Sql,
  tenantId: string,
  workspaceId: string,
  projectId: string,
): Promise<string> {
  const rows = await database<{ id: string }[]>`
    INSERT INTO generation_runs (
      tenant_id, workspace_id, project_id, skill_name, skill_version,
      prompt_version_id, model_key, input_hash, request_id
    ) VALUES (
      ${tenantId}, ${workspaceId}, ${projectId}, 'topic-planner', '1.0.0',
      ${PROMPT_VERSION}, 'mock-topic-model', ${'a'.repeat(64)}, ${`run-${tenantId}`}
    )
    RETURNING id
  `;
  const run = rows[0];
  if (!run) throw new Error('Expected generation run fixture');
  return run.id;
}

async function insertTopic(database: Sql, runId: string): Promise<string> {
  const rows = await database<{ id: string }[]>`
    INSERT INTO topic_candidates (
      tenant_id, workspace_id, project_id, generation_run_id, question, intent,
      entities_json, evidence_summary_json, platform_codes, priority, risk_level
    ) VALUES (
      ${TENANT_A}, ${WORKSPACE_A}, ${PROJECT_A}, ${runId},
      'How should an enterprise build GEO content?', 'informational',
      ${JSON.stringify(entities())}::text::jsonb,
      ${JSON.stringify(citations())}::text::jsonb,
      ARRAY['official_site', 'zhihu'], 90, 'medium'
    )
    RETURNING id
  `;
  const topic = rows[0];
  if (!topic) throw new Error('Expected topic candidate fixture');
  return topic.id;
}

function entities() {
  return { entities: ['GEO', 'enterprise content'], schema_version: 'entity-list@1' };
}

function citations() {
  return { evidence_ids: [], schema_version: 'citation-set@1' };
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Workspace PostgreSQL client was not initialized');
  return client;
}
