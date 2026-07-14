import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { KnowledgeRepository, type KnowledgeScope } from '../../src/modules/knowledge/index.js';

const USER_A = '10000000-0000-4000-8000-000000000029';
const USER_SCOPED = '10000000-0000-4000-8000-000000000129';
const USER_B = '10000000-0000-4000-8000-000000000229';
const TENANT_A = '20000000-0000-4000-8000-000000000029';
const TENANT_B = '20000000-0000-4000-8000-000000000129';
const WORKSPACE_A = '30000000-0000-4000-8000-000000000029';
const WORKSPACE_B = '30000000-0000-4000-8000-000000000129';
const WORKSPACE_A_OTHER = '30000000-0000-4000-8000-000000000229';
const PROJECT_A = '40000000-0000-4000-8000-000000000029';
const PROJECT_A2 = '40000000-0000-4000-8000-000000000129';
const PROJECT_B = '40000000-0000-4000-8000-000000000229';
const PROJECT_A_OTHER = '40000000-0000-4000-8000-000000000329';
const SOURCE_SHARED = '50000000-0000-4000-8000-000000000029';
const SOURCE_A = '50000000-0000-4000-8000-000000000129';
const SOURCE_A2 = '50000000-0000-4000-8000-000000000229';
const SOURCE_B = '50000000-0000-4000-8000-000000000329';
const SOURCE_A_OTHER = '50000000-0000-4000-8000-000000000429';
const CHUNK_SHARED = '60000000-0000-4000-8000-000000000029';
const CHUNK_A = '60000000-0000-4000-8000-000000000129';
const CHUNK_B = '60000000-0000-4000-8000-000000000229';
const CHUNK_A_OTHER = '60000000-0000-4000-8000-000000000329';
const CHUNK_A2 = '60000000-0000-4000-8000-000000000429';
const FACT_A = '70000000-0000-4000-8000-000000000029';
const FACT_B = '70000000-0000-4000-8000-000000000129';
const FACT_A2 = '70000000-0000-4000-8000-000000000229';

const SCOPE_A: KnowledgeScope = {
  projectId: PROJECT_A,
  tenantId: TENANT_A,
  userId: USER_SCOPED,
  workspaceId: WORKSPACE_A,
};

describe('knowledge database', () => {
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
    await seedIdentityAndScopes(database);
    await seedSources(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('installs all knowledge tables, frozen indexes, generated FTS, and tenant-scoped keys', async () => {
    const database = requireClient(client);
    const objects = await database<{ name: string }[]>`
      SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'source_documents', 'ingest_jobs', 'source_chunks',
          'embeddings', 'facts', 'fact_sources'
        )
      ORDER BY tablename
    `;
    expect(objects.map((item) => item.name)).toEqual([
      'embeddings',
      'fact_sources',
      'facts',
      'ingest_jobs',
      'source_chunks',
      'source_documents',
    ]);
    const indexes = await database<{ name: string }[]>`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'uq_source_hash_active',
          'source_chunks_search_vector_idx',
          'embeddings_vector_hnsw_idx',
          'facts_subject_predicate_status_idx'
        )
    `;
    expect(new Set(indexes.map((item) => item.name))).toEqual(
      new Set([
        'uq_source_hash_active',
        'source_chunks_search_vector_idx',
        'embeddings_vector_hnsw_idx',
        'facts_subject_predicate_status_idx',
      ]),
    );
    const tenantConstraints = await database<{ name: string }[]>`
      SELECT conname AS name
      FROM pg_constraint
      WHERE conname IN (
        'ingest_jobs_tenant_fk',
        'source_chunks_tenant_fk',
        'embeddings_id_tenant_uq',
        'embeddings_tenant_fk',
        'facts_tenant_fk',
        'fact_sources_id_tenant_uq',
        'fact_sources_tenant_fk'
      )
      ORDER BY conname
    `;
    expect(tenantConstraints.map((item) => item.name)).toEqual([
      'embeddings_id_tenant_uq',
      'embeddings_tenant_fk',
      'fact_sources_id_tenant_uq',
      'fact_sources_tenant_fk',
      'facts_tenant_fk',
      'ingest_jobs_tenant_fk',
      'source_chunks_tenant_fk',
    ]);

    await insertChunk(database, CHUNK_A, TENANT_A, SOURCE_A, 0, 'Enterprise GEO evidence');
    const searchable = await database<{ id: string }[]>`
      SELECT id FROM source_chunks
      WHERE search_vector @@ plainto_tsquery('simple', 'Enterprise')
    `;
    expect(searchable).toEqual([{ id: CHUNK_A }]);

    const vector = `[${Array.from({ length: 1536 }, () => '0').join(',')}]`;
    await database`
      INSERT INTO embeddings (tenant_id, chunk_id, model_key, embedding)
      VALUES (${TENANT_A}, ${CHUNK_A}, 'embedding-v1', ${vector}::vector)
    `;
    expect(
      await database<{ dimensions: number }[]>`
        SELECT vector_dims(embedding)::integer AS dimensions FROM embeddings
      `,
    ).toEqual([{ dimensions: 1536 }]);
  });

  it('rejects invalid MIME, duplicate content, malformed jobs/chunks, and forged scope links', async () => {
    const database = requireClient(client);
    await expect(
      database`
        INSERT INTO source_documents (
          tenant_id, workspace_id, project_id, title, source_type, mime_type,
          uri, content_hash, status, created_by
        ) VALUES (
          ${TENANT_A}, ${WORKSPACE_A}, ${PROJECT_A}, 'Bad MIME', 'pdf', 'text/plain',
          'memory://bad-mime', ${'8'.repeat(64)}, 'active', ${USER_A}
        )
      `,
    ).rejects.toThrow(/source_documents_type_mime_check/u);
    await expect(
      database`
        INSERT INTO source_documents (
          tenant_id, workspace_id, project_id, title, source_type, mime_type,
          uri, content_hash, status, created_by
        ) VALUES (
          ${TENANT_A}, ${WORKSPACE_A}, ${PROJECT_A}, 'Duplicate', 'txt', 'text/plain',
          'memory://duplicate', ${'1'.repeat(64)}, 'active', ${USER_A}
        )
      `,
    ).rejects.toThrow(/uq_source_hash_active/u);
    await expect(
      database`
        INSERT INTO source_documents (
          tenant_id, workspace_id, project_id, title, source_type, mime_type,
          uri, content_hash, status, created_by
        ) VALUES (
          ${TENANT_A}, ${WORKSPACE_B}, ${PROJECT_A}, 'Forged project', 'txt', 'text/plain',
          'memory://forged-project', ${'9'.repeat(64)}, 'active', ${USER_A}
        )
      `,
    ).rejects.toThrow(/source_documents_workspace_fk|source_documents_project_fk/u);

    await expect(
      database`
        INSERT INTO ingest_jobs (tenant_id, source_document_id, status, error_json)
        VALUES (
          ${TENANT_A}, ${SOURCE_A}, 'failed',
          '{"schema_version":"wrong","code":"PARSE","message":"bad"}'::jsonb
        )
      `,
    ).rejects.toThrow(/ingest_jobs_error_check|ingest_jobs_terminal_check/u);
    await expect(
      database`
        INSERT INTO source_chunks (
          tenant_id, source_document_id, chunk_no, text, text_hash,
          metadata_json, token_count
        ) VALUES (
          ${TENANT_A}, ${SOURCE_A}, 0, 'Invalid metadata', ${'a'.repeat(64)},
          '{"schema_version":"chunk-metadata@1","unknown":true}'::jsonb, 20
        )
      `,
    ).rejects.toThrow(/source_chunks_metadata_check|source_chunks_locator_required_check/u);
    await insertChunk(database, CHUNK_A, TENANT_A, SOURCE_A, 0, 'Valid chunk');
    await expect(
      insertChunk(database, undefined, TENANT_A, SOURCE_A, 0, 'Duplicate chunk'),
    ).rejects.toThrow(/source_chunks_source_chunk_uq/u);
  });

  it('isolates repository reads by tenant and project while including workspace-shared knowledge', async () => {
    const database = requireClient(client);
    const repository = new KnowledgeRepository(database);
    expect(
      (await repository.listSourceDocuments(SCOPE_A)).map((source) => source.id).sort(),
    ).toEqual([SOURCE_A, SOURCE_SHARED].sort());
    expect(await repository.findSourceDocument(SCOPE_A, SOURCE_A2)).toBeUndefined();
    expect(await repository.findSourceDocument(SCOPE_A, SOURCE_B)).toBeUndefined();

    await database`
      INSERT INTO ingest_jobs (tenant_id, source_document_id)
      VALUES (${TENANT_A}, ${SOURCE_A})
    `;
    await insertChunk(database, CHUNK_SHARED, TENANT_A, SOURCE_SHARED, 0, 'Shared evidence');
    expect(await repository.listIngestJobs(SCOPE_A, SOURCE_A)).toHaveLength(1);
    expect(await repository.listSourceChunks(SCOPE_A, SOURCE_SHARED)).toMatchObject([
      { id: CHUNK_SHARED, sourceDocumentId: SOURCE_SHARED },
    ]);

    const forbiddenScope = { ...SCOPE_A, projectId: PROJECT_A2 };
    expect(await repository.findSourceDocument(forbiddenScope, SOURCE_A)).toBeUndefined();
    expect(await repository.listSourceDocuments(forbiddenScope)).toEqual([]);
  });

  it('keeps facts in one workspace and evidence append-only', async () => {
    const database = requireClient(client);
    await insertChunk(database, CHUNK_A, TENANT_A, SOURCE_A, 0, 'Price is 100 CNY');
    await insertChunk(database, CHUNK_B, TENANT_B, SOURCE_B, 0, 'Other tenant evidence');
    await insertChunk(
      database,
      CHUNK_A_OTHER,
      TENANT_A,
      SOURCE_A_OTHER,
      0,
      'Other workspace evidence',
    );
    await insertChunk(database, CHUNK_A2, TENANT_A, SOURCE_A2, 0, 'Private project A2 fact');
    await database`
      INSERT INTO facts (
        id, tenant_id, workspace_id, subject, predicate, object_value,
        unit, confidence, status
      ) VALUES
        (${FACT_A}, ${TENANT_A}, ${WORKSPACE_A}, 'Product A', 'price', '100', 'CNY', 0.9500, 'verified'),
        (${FACT_B}, ${TENANT_B}, ${WORKSPACE_B}, 'Product B', 'price', '200', 'CNY', 0.9000, 'verified'),
        (${FACT_A2}, ${TENANT_A}, ${WORKSPACE_A}, 'Private A2', 'status', 'internal', NULL, 0.9000, 'verified')
    `;
    const evidence = await database<{ id: string }[]>`
      INSERT INTO fact_sources (tenant_id, fact_id, chunk_id, quote_text, quote_hash)
      VALUES (${TENANT_A}, ${FACT_A}, ${CHUNK_A}, 'Price is 100 CNY', ${'e'.repeat(64)})
      RETURNING id
    `;
    await database`
      INSERT INTO fact_sources (tenant_id, fact_id, chunk_id, quote_text, quote_hash)
      VALUES (${TENANT_A}, ${FACT_A2}, ${CHUNK_A2}, 'Private project A2 fact', ${'9'.repeat(64)})
    `;
    await expect(
      database`
        INSERT INTO fact_sources (tenant_id, fact_id, chunk_id, quote_text, quote_hash)
        VALUES (${TENANT_A}, ${FACT_A}, ${CHUNK_A_OTHER}, 'Forged evidence', ${'f'.repeat(64)})
      `,
    ).rejects.toThrow(/fact source must belong/u);
    await expect(
      database`
        INSERT INTO fact_sources (tenant_id, fact_id, chunk_id, quote_text, quote_hash)
        VALUES (${TENANT_A}, ${FACT_A}, ${CHUNK_B}, 'Cross tenant evidence', ${'d'.repeat(64)})
      `,
    ).rejects.toThrow(/fact_sources_chunk_fk|fact source must belong/u);
    await expect(
      database`UPDATE fact_sources SET quote_text = 'Changed' WHERE id = ${evidence[0]!.id}`,
    ).rejects.toThrow(/append-only/u);
    await expect(database`DELETE FROM fact_sources WHERE id = ${evidence[0]!.id}`).rejects.toThrow(
      /append-only/u,
    );

    const repository = new KnowledgeRepository(database);
    expect(await repository.listFacts(SCOPE_A)).toMatchObject([{ id: FACT_A }]);
    expect(await repository.listFactSources(SCOPE_A, FACT_A)).toMatchObject([
      { chunkId: CHUNK_A, factId: FACT_A, sourceDocumentId: SOURCE_A },
    ]);
  });
});

async function seedIdentityAndScopes(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status)
    VALUES
      (${USER_A}, 'knowledge-owner@example.com', 'Knowledge Owner', 'active'),
      (${USER_SCOPED}, 'knowledge-scoped@example.com', 'Knowledge Scoped', 'active'),
      (${USER_B}, 'knowledge-other@example.com', 'Knowledge Other', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES
      (${TENANT_A}, 'Knowledge Tenant A', 'knowledge-a', 'active'),
      (${TENANT_B}, 'Knowledge Tenant B', 'knowledge-b', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES
      (${TENANT_A}, ${USER_A}, 'tenant_owner', 'active'),
      (${TENANT_A}, ${USER_SCOPED}, 'content_editor', 'active'),
      (${TENANT_B}, ${USER_B}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES
      (${WORKSPACE_A}, ${TENANT_A}, 'Knowledge Workspace A', 'knowledge-workspace-a', 'UTC'),
      (${WORKSPACE_A_OTHER}, ${TENANT_A}, 'Knowledge Workspace A Other', 'knowledge-workspace-a-other', 'UTC'),
      (${WORKSPACE_B}, ${TENANT_B}, 'Knowledge Workspace B', 'knowledge-workspace-b', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES
      (${PROJECT_A}, ${TENANT_A}, ${WORKSPACE_A}, 'Knowledge Project A', ${USER_A}),
      (${PROJECT_A2}, ${TENANT_A}, ${WORKSPACE_A}, 'Knowledge Project A2', ${USER_A}),
      (${PROJECT_A_OTHER}, ${TENANT_A}, ${WORKSPACE_A_OTHER}, 'Knowledge Project A Other', ${USER_A}),
      (${PROJECT_B}, ${TENANT_B}, ${WORKSPACE_B}, 'Knowledge Project B', ${USER_B})
  `;
  await database`
    INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
    VALUES (
      ${WORKSPACE_A}, ${USER_SCOPED},
      ${JSON.stringify({ project_ids: [PROJECT_A], schema_version: 'workspace-scope@1' })}::text::jsonb
    )
  `;
}

async function seedSources(database: Sql): Promise<void> {
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
      uri, content_hash, trust_level, status, created_by
    ) VALUES
      (${SOURCE_SHARED}, ${TENANT_A}, ${WORKSPACE_A}, NULL, 'Shared source', 'txt', 'text/plain', 'memory://shared', ${'1'.repeat(64)}, 'verified', 'active', ${USER_A}),
      (${SOURCE_A}, ${TENANT_A}, ${WORKSPACE_A}, ${PROJECT_A}, 'Project A source', 'txt', 'text/plain', 'memory://project-a', ${'2'.repeat(64)}, 'normal', 'active', ${USER_A}),
      (${SOURCE_A2}, ${TENANT_A}, ${WORKSPACE_A}, ${PROJECT_A2}, 'Project A2 source', 'txt', 'text/plain', 'memory://project-a2', ${'3'.repeat(64)}, 'normal', 'active', ${USER_A}),
      (${SOURCE_B}, ${TENANT_B}, ${WORKSPACE_B}, ${PROJECT_B}, 'Project B source', 'txt', 'text/plain', 'memory://project-b', ${'4'.repeat(64)}, 'normal', 'active', ${USER_B}),
      (${SOURCE_A_OTHER}, ${TENANT_A}, ${WORKSPACE_A_OTHER}, ${PROJECT_A_OTHER}, 'Other workspace source', 'txt', 'text/plain', 'memory://workspace-other', ${'5'.repeat(64)}, 'normal', 'active', ${USER_A})
  `;
}

async function insertChunk(
  database: Sql,
  id: string | undefined,
  tenantId: string,
  sourceId: string,
  chunkNo: number,
  text: string,
): Promise<void> {
  await database`
    INSERT INTO source_chunks (
      id, tenant_id, source_document_id, chunk_no, text, text_hash,
      metadata_json, token_count
    ) VALUES (
      COALESCE(${id ?? null}::uuid, gen_random_uuid()), ${tenantId}, ${sourceId}, ${chunkNo},
      ${text}, ${'c'.repeat(64)},
      ${JSON.stringify({ char_end: text.length, char_start: 0, headings: [], schema_version: 'chunk-metadata@1' })}::text::jsonb,
      20
    )
  `;
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('Knowledge database client was not initialized');
  return value;
}
