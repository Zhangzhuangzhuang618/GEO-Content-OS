import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { FtsRepository, type FtsSearchScope } from '../../src/modules/knowledge/index.js';

const USER = '11000000-0000-4000-8000-000000000034';
const OTHER_USER = '11000000-0000-4000-8000-000000000134';
const TENANT = '21000000-0000-4000-8000-000000000034';
const OTHER_TENANT = '21000000-0000-4000-8000-000000000134';
const WORKSPACE = '31000000-0000-4000-8000-000000000034';
const OTHER_WORKSPACE = '31000000-0000-4000-8000-000000000134';
const PROJECT = '41000000-0000-4000-8000-000000000034';
const HIDDEN_PROJECT = '41000000-0000-4000-8000-000000000134';
const OTHER_PROJECT = '41000000-0000-4000-8000-000000000234';

const SOURCE_SHARED = '51000000-0000-4000-8000-000000000034';
const SOURCE_PROJECT = '51000000-0000-4000-8000-000000000134';
const SOURCE_HIDDEN = '51000000-0000-4000-8000-000000000234';
const SOURCE_OTHER = '51000000-0000-4000-8000-000000000334';
const SOURCE_FUTURE = '51000000-0000-4000-8000-000000000434';
const SOURCE_UNTRUSTED = '51000000-0000-4000-8000-000000000534';
const SOURCE_PROCESSING = '51000000-0000-4000-8000-000000000634';

const SCOPE: FtsSearchScope = {
  projectId: PROJECT,
  tenantId: TENANT,
  userId: USER,
  workspaceId: WORKSPACE,
};

describe('fts chunk search', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await seedScope(database);
    await seedSourcesAndChunks(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('ranks with ts_rank_cd while enforcing tenant, project, status, trust, and effective date', async () => {
    const repository = new FtsRepository(requireClient(client));

    const hits = await repository.search(SCOPE, 'enterprise GEO', {
      effectiveOn: '2026-07-14',
    });

    expect(hits.map((hit) => hit.sourceDocumentId)).toEqual([SOURCE_SHARED, SOURCE_PROJECT]);
    expect(hits[0]?.rank).toBeGreaterThan(hits[1]?.rank ?? 0);
    expect(hits[0]).toMatchObject({
      chunkNo: 0,
      metadata: {
        char_end: expect.any(Number),
        char_start: 0,
        schema_version: 'chunk-metadata@1',
      },
      sourceTitle: 'Shared verified source',
      trustLevel: 'verified',
    });

    const futureHits = await repository.search(SCOPE, 'enterprise GEO', {
      effectiveOn: '2027-01-01',
      trustLevels: ['normal'],
    });
    expect(futureHits.map((hit) => hit.sourceDocumentId).sort()).toEqual(
      [SOURCE_FUTURE, SOURCE_PROJECT].sort(),
    );
    expect(
      await repository.search(SCOPE, 'enterprise GEO', {
        effectiveOn: '2026-07-14',
        trustLevels: ['untrusted'],
      }),
    ).toMatchObject([{ sourceDocumentId: SOURCE_UNTRUSTED }]);
  });

  it('returns no rows for forged tenant/project scopes and validates query controls', async () => {
    const repository = new FtsRepository(requireClient(client));

    expect(await repository.search({ ...SCOPE, tenantId: OTHER_TENANT }, 'enterprise')).toEqual([]);
    expect(await repository.search({ ...SCOPE, projectId: HIDDEN_PROJECT }, 'enterprise')).toEqual(
      [],
    );
    await expect(repository.search(SCOPE, '   ')).rejects.toThrow(TypeError);
    await expect(repository.search(SCOPE, 'enterprise', { limit: 101 })).rejects.toThrow(TypeError);
    await expect(
      repository.search(SCOPE, 'enterprise', { effectiveOn: '2026-02-30' }),
    ).rejects.toThrow(TypeError);
    await expect(repository.search(SCOPE, 'enterprise', { trustLevels: [] })).rejects.toThrow(
      TypeError,
    );
  });

  it('installs the GIN vector and enforces frozen token and locator limits', async () => {
    const database = requireClient(client);
    const indexes = await database<{ definition: string }[]>`
      SELECT indexdef AS definition
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'source_chunks_search_vector_idx'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.definition.toLowerCase()).toContain('using gin (search_vector)');

    await expect(
      insertChunk(database, SOURCE_PROJECT, 'too many tokens', {
        metadata: { char_end: 15, char_start: 0, schema_version: 'chunk-metadata@1' },
        tokenCount: 901,
      }),
    ).rejects.toThrow(/source_chunks_token_count_max_check/u);
    await expect(
      insertChunk(database, SOURCE_PROJECT, 'missing locator', {
        metadata: { schema_version: 'chunk-metadata@1' },
      }),
    ).rejects.toThrow(/source_chunks_locator_required_check/u);
  });
});

async function seedScope(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status) VALUES
      (${USER}, 'fts-user@example.com', 'FTS User', 'active'),
      (${OTHER_USER}, 'fts-other@example.com', 'FTS Other', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status) VALUES
      (${TENANT}, 'FTS Tenant', 'fts-tenant', 'active'),
      (${OTHER_TENANT}, 'FTS Other Tenant', 'fts-other-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status) VALUES
      (${TENANT}, ${USER}, 'content_editor', 'active'),
      (${TENANT}, ${OTHER_USER}, 'tenant_owner', 'active'),
      (${OTHER_TENANT}, ${OTHER_USER}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone) VALUES
      (${WORKSPACE}, ${TENANT}, 'FTS Workspace', 'fts-workspace', 'UTC'),
      (${OTHER_WORKSPACE}, ${OTHER_TENANT}, 'Other FTS Workspace', 'other-fts-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id) VALUES
      (${PROJECT}, ${TENANT}, ${WORKSPACE}, 'FTS Project', ${OTHER_USER}),
      (${HIDDEN_PROJECT}, ${TENANT}, ${WORKSPACE}, 'Hidden FTS Project', ${OTHER_USER}),
      (${OTHER_PROJECT}, ${OTHER_TENANT}, ${OTHER_WORKSPACE}, 'Other FTS Project', ${OTHER_USER})
  `;
  await database`
    INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
    VALUES (
      ${WORKSPACE}, ${USER},
      ${JSON.stringify({ project_ids: [PROJECT], schema_version: 'workspace-scope@1' })}::text::jsonb
    )
  `;
}

async function seedSourcesAndChunks(database: Sql): Promise<void> {
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
      uri, content_hash, trust_level, effective_from, status, created_by
    ) VALUES
      (${SOURCE_SHARED}, ${TENANT}, ${WORKSPACE}, NULL, 'Shared verified source', 'txt', 'text/plain', 'memory://fts/shared', ${'1'.repeat(64)}, 'verified', NULL, 'active', ${OTHER_USER}),
      (${SOURCE_PROJECT}, ${TENANT}, ${WORKSPACE}, ${PROJECT}, 'Project source', 'txt', 'text/plain', 'memory://fts/project', ${'2'.repeat(64)}, 'normal', NULL, 'active', ${OTHER_USER}),
      (${SOURCE_HIDDEN}, ${TENANT}, ${WORKSPACE}, ${HIDDEN_PROJECT}, 'Hidden project source', 'txt', 'text/plain', 'memory://fts/hidden', ${'3'.repeat(64)}, 'normal', NULL, 'active', ${OTHER_USER}),
      (${SOURCE_OTHER}, ${OTHER_TENANT}, ${OTHER_WORKSPACE}, ${OTHER_PROJECT}, 'Other tenant source', 'txt', 'text/plain', 'memory://fts/other', ${'4'.repeat(64)}, 'verified', NULL, 'active', ${OTHER_USER}),
      (${SOURCE_FUTURE}, ${TENANT}, ${WORKSPACE}, ${PROJECT}, 'Future source', 'txt', 'text/plain', 'memory://fts/future', ${'5'.repeat(64)}, 'normal', '2026-12-01', 'active', ${OTHER_USER}),
      (${SOURCE_UNTRUSTED}, ${TENANT}, ${WORKSPACE}, ${PROJECT}, 'Untrusted source', 'txt', 'text/plain', 'memory://fts/untrusted', ${'6'.repeat(64)}, 'untrusted', NULL, 'active', ${OTHER_USER}),
      (${SOURCE_PROCESSING}, ${TENANT}, ${WORKSPACE}, ${PROJECT}, 'Processing source', 'txt', 'text/plain', 'memory://fts/processing', ${'7'.repeat(64)}, 'normal', NULL, 'processing', ${OTHER_USER})
  `;
  await insertChunk(
    database,
    SOURCE_SHARED,
    'enterprise GEO enterprise GEO enterprise GEO authoritative evidence',
  );
  await insertChunk(database, SOURCE_PROJECT, 'enterprise GEO project evidence');
  await insertChunk(database, SOURCE_HIDDEN, 'enterprise GEO hidden evidence');
  await insertChunk(database, SOURCE_OTHER, 'enterprise GEO other tenant evidence');
  await insertChunk(database, SOURCE_FUTURE, 'enterprise GEO future evidence');
  await insertChunk(database, SOURCE_UNTRUSTED, 'enterprise GEO untrusted evidence');
  await insertChunk(database, SOURCE_PROCESSING, 'enterprise GEO processing evidence');
  await insertChunk(database, SOURCE_PROJECT, 'enterprise GEO inactive chunk', {
    chunkNo: 1,
    status: 'inactive',
  });
}

async function insertChunk(
  database: Sql,
  sourceId: string,
  text: string,
  options: {
    readonly chunkNo?: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly status?: 'active' | 'inactive';
    readonly tokenCount?: number;
  } = {},
): Promise<void> {
  const metadata =
    options.metadata ??
    ({
      char_end: text.length,
      char_start: 0,
      headings: [],
      schema_version: 'chunk-metadata@1',
    } as const);
  await database`
    INSERT INTO source_chunks (
      tenant_id, source_document_id, chunk_no, text, text_hash,
      metadata_json, token_count, status
    )
    SELECT
      source.tenant_id, source.id, ${options.chunkNo ?? 0}, ${text}, ${'c'.repeat(64)},
      ${JSON.stringify(metadata)}::text::jsonb, ${options.tokenCount ?? text.split(/\s+/u).length},
      ${options.status ?? 'active'}
    FROM source_documents AS source
    WHERE source.id = ${sourceId}
  `;
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('FTS integration database client was not initialized');
  return value;
}
