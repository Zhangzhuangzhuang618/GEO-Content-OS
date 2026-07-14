import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash, randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { ContentRepository, type ContentScope } from '../../src/modules/content/index.js';

const USER_A = '11000000-0000-4000-8000-000000000043';
const USER_B = '11000000-0000-4000-8000-000000000143';
const TENANT_A = '21000000-0000-4000-8000-000000000043';
const TENANT_B = '21000000-0000-4000-8000-000000000143';
const WORKSPACE_A = '31000000-0000-4000-8000-000000000043';
const WORKSPACE_B = '31000000-0000-4000-8000-000000000143';
const PROJECT_A = '41000000-0000-4000-8000-000000000043';
const PROJECT_B = '41000000-0000-4000-8000-000000000143';
const BRIEF_A = '51000000-0000-4000-8000-000000000043';
const BRIEF_B = '51000000-0000-4000-8000-000000000143';
const PACKAGE_A = '61000000-0000-4000-8000-000000000043';
const PACKAGE_B = '61000000-0000-4000-8000-000000000143';
const VARIANT_A = '71000000-0000-4000-8000-000000000043';
const VARIANT_B = '71000000-0000-4000-8000-000000000143';
const MASTER_VERSION_A = '81000000-0000-4000-8000-000000000043';
const VARIANT_VERSION_A = '81000000-0000-4000-8000-000000000143';
const SOURCE_A = '91000000-0000-4000-8000-000000000043';
const SOURCE_B = '91000000-0000-4000-8000-000000000143';
const CHUNK_A = 'a1000000-0000-4000-8000-000000000043';
const CHUNK_B = 'a1000000-0000-4000-8000-000000000143';
const RUN_A = 'b1000000-0000-4000-8000-000000000043';
const BLOCK_A = 'c1000000-0000-4000-8000-000000000043';
const CITATION_A = 'd1000000-0000-4000-8000-000000000043';
const QUOTE = '退款周期为 30 天';

const SCOPE_A: ContentScope = {
  projectId: PROJECT_A,
  tenantId: TENANT_A,
  userId: USER_A,
  workspaceId: WORKSPACE_A,
};

describe('content database', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE ai_citations, content_block_locks, content_blocks, content_versions, content_variants, content_packages, fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await seedScopes(database);
    await seedContentGraph(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('installs the frozen content tables, indexes, circular pointers, and run relationships', async () => {
    const database = requireClient(client);
    const tables = await database<{ name: string }[]>`
      SELECT tablename AS name
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename IN (
        'content_packages', 'content_variants', 'content_versions',
        'content_blocks', 'content_block_locks', 'ai_citations'
      )
      ORDER BY tablename
    `;
    expect(tables.map((table) => table.name)).toEqual([
      'ai_citations',
      'content_block_locks',
      'content_blocks',
      'content_packages',
      'content_variants',
      'content_versions',
    ]);
    const indexes = await database<{ name: string }[]>`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (
        'content_packages_scope_status_idx',
        'content_variants_package_platform_uq',
        'content_versions_object_version_uq',
        'content_versions_object_hash_uq',
        'ai_citations_chunk_idx'
      )
    `;
    expect(new Set(indexes.map((index) => index.name))).toEqual(
      new Set([
        'content_packages_scope_status_idx',
        'content_variants_package_platform_uq',
        'content_versions_object_version_uq',
        'content_versions_object_hash_uq',
        'ai_citations_chunk_idx',
      ]),
    );
    const pointers = await database<
      { masterVersion: string | null; runVariant: string | null; variantVersion: string | null }[]
    >`
      SELECT
        package.master_content_version_id AS "masterVersion",
        variant.current_content_version_id AS "variantVersion",
        run.variant_id AS "runVariant"
      FROM content_packages AS package
      JOIN content_variants AS variant ON variant.package_id = package.id
      JOIN generation_runs AS run ON run.package_id = package.id
      WHERE package.id = ${PACKAGE_A}::uuid
    `;
    expect(pointers).toEqual([
      {
        masterVersion: MASTER_VERSION_A,
        runVariant: VARIANT_A,
        variantVersion: VARIANT_VERSION_A,
      },
    ]);
  });

  it('returns only authorized tenant/project content with complete immutable provenance', async () => {
    const database = requireClient(client);
    const repository = new ContentRepository(database);
    expect(await repository.findBrief(SCOPE_A, BRIEF_A)).toMatchObject({
      id: BRIEF_A,
      platformCodes: ['official_site', 'zhihu'],
      tenantId: TENANT_A,
    });
    expect(await repository.listBriefs(SCOPE_A)).toHaveLength(1);
    expect(await repository.findPackage(SCOPE_A, PACKAGE_A)).toMatchObject({
      id: PACKAGE_A,
      masterContentVersionId: MASTER_VERSION_A,
    });
    expect(await repository.listPackages(SCOPE_A)).toHaveLength(1);
    expect(await repository.listVariants(SCOPE_A, PACKAGE_A)).toMatchObject([
      { id: VARIANT_A, platformCode: 'zhihu', currentContentVersionId: VARIANT_VERSION_A },
    ]);
    expect(await repository.listVersions(SCOPE_A, PACKAGE_A, null)).toMatchObject([
      { id: MASTER_VERSION_A, variantId: null, versionNo: 1 },
    ]);
    expect(await repository.findVersion(SCOPE_A, VARIANT_VERSION_A)).toMatchObject({
      id: VARIANT_VERSION_A,
      sourceRunId: RUN_A,
    });
    expect(await repository.listBlocks(SCOPE_A, VARIANT_VERSION_A)).toMatchObject([
      { blockKey: 'body-1', id: BLOCK_A, position: 0 },
    ]);
    expect(await repository.listBlockLocks(SCOPE_A, VARIANT_A)).toMatchObject([
      { blockKey: 'body-1', lockedContentHash: sha256(QUOTE) },
    ]);
    expect(await repository.listCitations(SCOPE_A, VARIANT_VERSION_A)).toMatchObject([
      { chunkId: CHUNK_A, id: CITATION_A, quoteText: QUOTE },
    ]);
    expect(await repository.listRuns(SCOPE_A, PACKAGE_A)).toMatchObject([
      { id: RUN_A, packageId: PACKAGE_A, variantId: VARIANT_A },
    ]);

    const forbidden = { ...SCOPE_A, tenantId: TENANT_B, userId: USER_B };
    expect(await repository.findBrief(forbidden, BRIEF_A)).toBeUndefined();
    expect(await repository.findPackage(forbidden, PACKAGE_A)).toBeUndefined();
    expect(await repository.findVersion(forbidden, VARIANT_VERSION_A)).toBeUndefined();
    expect(await repository.listVariants(forbidden, PACKAGE_A)).toEqual([]);
    expect(await repository.listCitations(forbidden, VARIANT_VERSION_A)).toEqual([]);
  });

  it('keeps versions, blocks, and citations append-only and rejects duplicate object history', async () => {
    const database = requireClient(client);
    await expect(
      database`UPDATE content_versions SET content_hash = ${'f'.repeat(64)} WHERE id = ${VARIANT_VERSION_A}::uuid`,
    ).rejects.toThrow(/content versions are append-only/u);
    await expect(database`DELETE FROM content_blocks WHERE id = ${BLOCK_A}::uuid`).rejects.toThrow(
      /content blocks are append-only/u,
    );
    await expect(
      database`UPDATE ai_citations SET claim_text = 'changed' WHERE id = ${CITATION_A}::uuid`,
    ).rejects.toThrow(/AI citations are append-only/u);
    await expect(
      insertVersion(database, {
        contentHash: 'e'.repeat(64),
        id: undefined,
        packageId: PACKAGE_A,
        tenantId: TENANT_A,
        userId: USER_A,
        variantId: VARIANT_A,
        versionNo: 1,
      }),
    ).rejects.toThrow(/content_versions_object_version_uq/u);
    await expect(
      insertVersion(database, {
        contentHash: sha256('variant-content-v1'),
        id: undefined,
        packageId: PACKAGE_A,
        tenantId: TENANT_A,
        userId: USER_A,
        variantId: VARIANT_A,
        versionNo: 2,
      }),
    ).rejects.toThrow(/content_versions_object_hash_uq/u);
  });

  it('rejects forged pointers, cross-scope citations, malformed content, and stale block locks', async () => {
    const database = requireClient(client);
    await expect(
      database`
        UPDATE content_packages SET master_content_version_id = ${VARIANT_VERSION_A}::uuid
        WHERE id = ${PACKAGE_A}::uuid
      `,
    ).rejects.toThrow(/master content version/u);
    await expect(
      database`
        UPDATE content_variants SET current_content_version_id = ${MASTER_VERSION_A}::uuid
        WHERE id = ${VARIANT_A}::uuid
      `,
    ).rejects.toThrow(/content_variants_current_version_fk/u);
    await expect(
      database`
        INSERT INTO content_versions (
          tenant_id, package_id, variant_id, version_no, schema_version,
          content_json, content_hash, created_by
        ) VALUES (
          ${TENANT_A}, ${PACKAGE_A}, ${VARIANT_A}, 2, 'content-zhihu@1',
          '{"schema_version":"wrong"}'::jsonb, ${'f'.repeat(64)}, ${USER_A}
        )
      `,
    ).rejects.toThrow(/content_versions_content_check/u);
    await expect(
      database`
        INSERT INTO ai_citations (
          tenant_id, content_version_id, claim_key, claim_text,
          chunk_id, quote_text, quote_hash
        ) VALUES (
          ${TENANT_A}, ${VARIANT_VERSION_A}, 'bad-hash', '退款周期为 30 天',
          ${CHUNK_A}, ${QUOTE}, ${'0'.repeat(64)}
        )
      `,
    ).rejects.toThrow(/citation quote hash/u);
    await expect(
      database`
        INSERT INTO ai_citations (
          tenant_id, content_version_id, claim_key, claim_text,
          chunk_id, quote_text, quote_hash
        ) VALUES (
          ${TENANT_A}, ${VARIANT_VERSION_A}, 'cross-scope', '其他租户证据',
          ${CHUNK_B}, '其他租户证据', ${sha256('其他租户证据')}
        )
      `,
    ).rejects.toThrow(/ai_citations_chunk_fk|continuous substring/u);
    await expect(
      database`
        UPDATE content_block_locks SET locked_content_hash = ${'0'.repeat(64)}
        WHERE variant_id = ${VARIANT_A}::uuid
      `,
    ).rejects.toThrow(/block lock hash/u);
    await expect(
      database`
        INSERT INTO content_packages (
          tenant_id, workspace_id, project_id, brief_id, created_by
        ) VALUES (${TENANT_A}, ${WORKSPACE_A}, ${PROJECT_A}, ${BRIEF_B}, ${USER_A})
      `,
    ).rejects.toThrow(/content_packages_brief_fk/u);
    await expect(
      database`
        INSERT INTO content_variants (tenant_id, package_id, platform_code)
        VALUES (${TENANT_A}, ${PACKAGE_A}, 'douyin')
      `,
    ).rejects.toThrow(/platform is not selected/u);
    await expect(
      database`
        INSERT INTO generation_runs (
          tenant_id, workspace_id, package_id, skill_name, skill_version,
          prompt_version_id, model_key, input_hash, request_id
        ) VALUES (
          ${TENANT_A}, ${WORKSPACE_A}, ${PACKAGE_A}, 'content-producer', '1.0.0',
          ${'e1000000-0000-4000-8000-000000000143'}, 'mock-model',
          ${'3'.repeat(64)}, 'missing-project'
        )
      `,
    ).rejects.toThrow(/generation_runs_content_scope_check/u);
  });
});

async function seedScopes(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status) VALUES
      (${USER_A}, 'content-a@example.com', 'Content A', 'active'),
      (${USER_B}, 'content-b@example.com', 'Content B', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status) VALUES
      (${TENANT_A}, 'Content Tenant A', 'content-tenant-a', 'active'),
      (${TENANT_B}, 'Content Tenant B', 'content-tenant-b', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status) VALUES
      (${TENANT_A}, ${USER_A}, 'tenant_owner', 'active'),
      (${TENANT_B}, ${USER_B}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone) VALUES
      (${WORKSPACE_A}, ${TENANT_A}, 'Content Workspace A', 'content-workspace-a', 'UTC'),
      (${WORKSPACE_B}, ${TENANT_B}, 'Content Workspace B', 'content-workspace-b', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id) VALUES
      (${PROJECT_A}, ${TENANT_A}, ${WORKSPACE_A}, 'Content Project A', ${USER_A}),
      (${PROJECT_B}, ${TENANT_B}, ${WORKSPACE_B}, 'Content Project B', ${USER_B})
  `;
  await database`
    INSERT INTO briefs (
      id, tenant_id, workspace_id, project_id, title, objective, audience,
      platform_codes, constraints_json, created_by
    ) VALUES
      (${BRIEF_A}, ${TENANT_A}, ${WORKSPACE_A}, ${PROJECT_A}, '企业 GEO 内容', 'trust',
        '面向企业内容和品牌团队的核心决策人群', ARRAY['official_site','zhihu'],
        '{"schema_version":"brief-constraints@1"}'::jsonb, ${USER_A}),
      (${BRIEF_B}, ${TENANT_B}, ${WORKSPACE_B}, ${PROJECT_B}, '其他租户内容', 'trust',
        '面向其他租户的独立业务决策人群', ARRAY['zhihu'],
        '{"schema_version":"brief-constraints@1"}'::jsonb, ${USER_B})
  `;
  await insertSource(database, TENANT_A, WORKSPACE_A, PROJECT_A, SOURCE_A, CHUNK_A, USER_A, QUOTE);
  await insertSource(
    database,
    TENANT_B,
    WORKSPACE_B,
    PROJECT_B,
    SOURCE_B,
    CHUNK_B,
    USER_B,
    '其他租户证据',
  );
}

async function seedContentGraph(database: Sql): Promise<void> {
  await database`
    INSERT INTO content_packages (
      id, tenant_id, workspace_id, project_id, brief_id, created_by
    ) VALUES
      (${PACKAGE_A}, ${TENANT_A}, ${WORKSPACE_A}, ${PROJECT_A}, ${BRIEF_A}, ${USER_A}),
      (${PACKAGE_B}, ${TENANT_B}, ${WORKSPACE_B}, ${PROJECT_B}, ${BRIEF_B}, ${USER_B})
  `;
  await database`
    INSERT INTO content_variants (id, tenant_id, package_id, platform_code) VALUES
      (${VARIANT_A}, ${TENANT_A}, ${PACKAGE_A}, 'zhihu'),
      (${VARIANT_B}, ${TENANT_B}, ${PACKAGE_B}, 'zhihu')
  `;
  await database`
    INSERT INTO generation_runs (
      id, tenant_id, workspace_id, project_id, package_id, variant_id,
      skill_name, skill_version, prompt_version_id, model_key, input_hash, request_id
    ) VALUES (
      ${RUN_A}, ${TENANT_A}, ${WORKSPACE_A}, ${PROJECT_A}, ${PACKAGE_A}, ${VARIANT_A},
      'content-producer', '1.0.0', ${'e1000000-0000-4000-8000-000000000043'},
      'mock-content-model', ${'1'.repeat(64)}, 'content-run-a'
    )
  `;
  await insertVersion(database, {
    contentHash: sha256('master-content-v1'),
    id: MASTER_VERSION_A,
    packageId: PACKAGE_A,
    tenantId: TENANT_A,
    userId: USER_A,
    variantId: null,
    versionNo: 1,
  });
  await insertVersion(database, {
    contentHash: sha256('variant-content-v1'),
    id: VARIANT_VERSION_A,
    packageId: PACKAGE_A,
    sourceRunId: RUN_A,
    tenantId: TENANT_A,
    userId: USER_A,
    variantId: VARIANT_A,
    versionNo: 1,
  });
  await database`
    UPDATE content_packages SET master_content_version_id = ${MASTER_VERSION_A}
    WHERE id = ${PACKAGE_A}
  `;
  await database`
    UPDATE content_variants SET current_content_version_id = ${VARIANT_VERSION_A}
    WHERE id = ${VARIANT_A}
  `;
  await database`
    INSERT INTO content_blocks (
      id, tenant_id, content_version_id, block_key, block_type, position, text_hash
    ) VALUES (
      ${BLOCK_A}, ${TENANT_A}, ${VARIANT_VERSION_A}, 'body-1', 'paragraph', 0, ${sha256(QUOTE)}
    )
  `;
  await database`
    INSERT INTO content_block_locks (
      tenant_id, variant_id, block_key, locked_content_hash, locked_by, reason
    ) VALUES (
      ${TENANT_A}, ${VARIANT_A}, 'body-1', ${sha256(QUOTE)}, ${USER_A}, '保留已核验事实'
    )
  `;
  await database`
    INSERT INTO ai_citations (
      id, tenant_id, content_version_id, claim_key, claim_text,
      chunk_id, quote_text, quote_hash
    ) VALUES (
      ${CITATION_A}, ${TENANT_A}, ${VARIANT_VERSION_A}, 'refund-window', ${QUOTE},
      ${CHUNK_A}, ${QUOTE}, ${sha256(QUOTE)}
    )
  `;
}

async function insertVersion(
  database: Sql,
  input: {
    readonly contentHash: string;
    readonly id: string | undefined;
    readonly packageId: string;
    readonly sourceRunId?: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly variantId: string | null;
    readonly versionNo: number;
  },
): Promise<void> {
  await database`
    INSERT INTO content_versions (
      id, tenant_id, package_id, variant_id, version_no, schema_version,
      content_json, content_hash, source_run_id, created_by
    ) VALUES (
      ${input.id ?? randomUUID()}::uuid, ${input.tenantId}, ${input.packageId}, ${input.variantId},
      ${input.versionNo}, ${input.variantId ? 'content-zhihu@1' : 'content-master@1'},
      ${JSON.stringify({
        blocks: [{ key: 'body-1', text: QUOTE, type: 'paragraph' }],
        schema_version: input.variantId ? 'content-zhihu@1' : 'content-master@1',
      })}::text::jsonb,
      ${input.contentHash}, ${input.sourceRunId ?? null}, ${input.userId}
    )
  `;
}

async function insertSource(
  database: Sql,
  tenantId: string,
  workspaceId: string,
  projectId: string,
  sourceId: string,
  chunkId: string,
  userId: string,
  text: string,
): Promise<void> {
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
      uri, content_hash, status, created_by
    ) VALUES (
      ${sourceId}, ${tenantId}, ${workspaceId}, ${projectId}, 'Citation source', 'txt',
      'text/plain', ${`memory://content/${sourceId}`}, ${sha256(sourceId)}, 'active', ${userId}
    )
  `;
  await database`
    INSERT INTO source_chunks (
      id, tenant_id, source_document_id, chunk_no, text, text_hash,
      metadata_json, token_count
    ) VALUES (
      ${chunkId}, ${tenantId}, ${sourceId}, 0, ${text}, ${sha256(text)},
      ${JSON.stringify({ char_end: text.length, char_start: 0, schema_version: 'chunk-metadata@1' })}::text::jsonb,
      8
    )
  `;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('PostgreSQL test client is unavailable');
  return value;
}
