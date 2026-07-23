import { createHash } from 'node:crypto';

import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  HybridSearchRepository,
  type HybridSearchScope,
} from '../../src/modules/knowledge/index.js';

const USER = '13000000-0000-4000-8000-000000000036';
const OWNER = '13000000-0000-4000-8000-000000000136';
const TENANT = '23000000-0000-4000-8000-000000000036';
const OTHER_TENANT = '23000000-0000-4000-8000-000000000136';
const WORKSPACE = '33000000-0000-4000-8000-000000000036';
const OTHER_WORKSPACE = '33000000-0000-4000-8000-000000000136';
const PROJECT = '43000000-0000-4000-8000-000000000036';
const HIDDEN_PROJECT = '43000000-0000-4000-8000-000000000136';
const OTHER_WORKSPACE_PROJECT = '43000000-0000-4000-8000-000000000236';
const MODEL_KEY = 'hybrid-search-test-v1';

const SHARED = '53000000-0000-4000-8000-000000000036';
const PROJECT_SOURCE = '53000000-0000-4000-8000-000000000136';
const LEXICAL = '53000000-0000-4000-8000-000000000236';
const VECTOR = '53000000-0000-4000-8000-000000000336';
const FUTURE = '53000000-0000-4000-8000-000000000436';
const UNTRUSTED = '53000000-0000-4000-8000-000000000536';
const HIDDEN = '53000000-0000-4000-8000-000000000636';
const PROCESSING = '53000000-0000-4000-8000-000000000736';
const EXPIRED = '53000000-0000-4000-8000-000000000836';
const OTHER_WORKSPACE_SOURCE = '53000000-0000-4000-8000-000000000936';

const QUERY_VECTOR = Object.freeze([1, ...Array<number>(1_535).fill(0)]);
const SCOPE: HybridSearchScope = {
  projectId: PROJECT,
  tenantId: TENANT,
  userId: USER,
  workspaceId: WORKSPACE,
};

describe('hybrid knowledge search', () => {
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
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('normalizes and fuses FTS/vector candidates into stable citation-ready hits', async () => {
    const repository = new HybridSearchRepository(requireClient(client));
    const hits = await repository.search(SCOPE, 'enterprise GEO', QUERY_VECTOR, {
      effectiveOn: '2026-07-14',
      modelKey: MODEL_KEY,
      topK: 10,
    });

    expect(hits.map((hit) => hit.sourceDocumentId).sort()).toEqual(
      [SHARED, PROJECT_SOURCE, LEXICAL, VECTOR].sort(),
    );
    expect(
      hits
        .slice(0, 2)
        .map((hit) => hit.sourceDocumentId)
        .sort(),
    ).toEqual([SHARED, PROJECT_SOURCE].sort());
    expect(hits.slice(0, 2).every((hit) => hit.matchSignals.join(',') === 'fts,vector')).toBe(true);
    expect(hits.every((hit) => hit.score >= 0 && hit.score <= 1)).toBe(true);
    expect(hits.every((hit, index) => index === 0 || hits[index - 1]!.score >= hit.score)).toBe(
      true,
    );
    expect(hits.find((hit) => hit.sourceDocumentId === SHARED)).toMatchObject({
      metadata: {
        char_end: expect.any(Number),
        char_start: 0,
        headings: ['Evidence'],
        page: 1,
        schema_version: 'chunk-metadata@1',
      },
      projectId: null,
      sourceTitle: 'Shared verified source',
      sourceUri: 'memory://hybrid/shared-verified-source',
      trustLevel: 'verified',
    });
  });

  it('enforces tenant, project, trust, effective-date, and live-state filters', async () => {
    const repository = new HybridSearchRepository(requireClient(client));

    const verified = await repository.search(SCOPE, 'enterprise GEO', QUERY_VECTOR, {
      effectiveOn: '2026-07-14',
      modelKey: MODEL_KEY,
      trustLevels: ['verified'],
    });
    expect(verified.map((hit) => hit.sourceDocumentId)).toEqual([SHARED]);

    expect(
      await repository.search(
        { ...SCOPE, tenantId: OTHER_TENANT },
        'enterprise GEO',
        QUERY_VECTOR,
        {
          effectiveOn: '2026-07-14',
          modelKey: MODEL_KEY,
        },
      ),
    ).toEqual([]);
    expect(
      await repository.search(
        { ...SCOPE, projectId: HIDDEN_PROJECT },
        'enterprise GEO',
        QUERY_VECTOR,
        {
          effectiveOn: '2026-07-14',
          modelKey: MODEL_KEY,
        },
      ),
    ).toEqual([]);
  });

  it('degrades deterministically to FTS when the requested embedding model is absent', async () => {
    const repository = new HybridSearchRepository(requireClient(client));
    const hits = await repository.search(SCOPE, 'enterprise GEO', QUERY_VECTOR, {
      effectiveOn: '2026-07-14',
      modelKey: 'embedding-model-not-indexed',
    });

    expect(hits.map((hit) => hit.sourceDocumentId).sort()).toEqual(
      [SHARED, PROJECT_SOURCE, LEXICAL].sort(),
    );
    expect(hits.every((hit) => hit.matchSignals.join(',') === 'fts')).toBe(true);
    expect(hits.every((hit) => hit.vectorScore === 0)).toBe(true);
  });
});

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status) VALUES
      (${USER}, 'hybrid-user@example.com', 'Hybrid User', 'active'),
      (${OWNER}, 'hybrid-owner@example.com', 'Hybrid Owner', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status) VALUES
      (${TENANT}, 'Hybrid Tenant', 'hybrid-tenant', 'active'),
      (${OTHER_TENANT}, 'Other Hybrid Tenant', 'other-hybrid-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status) VALUES
      (${TENANT}, ${USER}, 'content_editor', 'active'),
      (${TENANT}, ${OWNER}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone) VALUES
      (${WORKSPACE}, ${TENANT}, 'Hybrid Workspace', 'hybrid-workspace', 'UTC'),
      (${OTHER_WORKSPACE}, ${TENANT}, 'Other Workspace', 'other-hybrid-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id) VALUES
      (${PROJECT}, ${TENANT}, ${WORKSPACE}, 'Hybrid Project', ${OWNER}),
      (${HIDDEN_PROJECT}, ${TENANT}, ${WORKSPACE}, 'Hidden Project', ${OWNER}),
      (${OTHER_WORKSPACE_PROJECT}, ${TENANT}, ${OTHER_WORKSPACE}, 'Other Workspace Project', ${OWNER})
  `;
  await database`
    INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
    VALUES (
      ${WORKSPACE}, ${USER},
      ${JSON.stringify({ project_ids: [PROJECT], schema_version: 'workspace-scope@1' })}::text::jsonb
    )
  `;
  await insertSource(database, SHARED, null, 'Shared verified source', 'verified', 'active');
  await insertSource(database, PROJECT_SOURCE, PROJECT, 'Project source', 'normal', 'active');
  await insertSource(database, LEXICAL, PROJECT, 'Lexical source', 'normal', 'active');
  await insertSource(database, VECTOR, PROJECT, 'Vector source', 'normal', 'active');
  await insertSource(database, FUTURE, PROJECT, 'Future source', 'normal', 'active', '2027-01-01');
  await insertSource(database, UNTRUSTED, PROJECT, 'Untrusted source', 'untrusted', 'active');
  await insertSource(database, HIDDEN, HIDDEN_PROJECT, 'Hidden source', 'normal', 'active');
  await insertSource(database, PROCESSING, PROJECT, 'Processing source', 'normal', 'processing');
  await insertSource(
    database,
    EXPIRED,
    PROJECT,
    'Expired source',
    'normal',
    'active',
    null,
    '2026-01-01',
  );
  await insertSource(
    database,
    OTHER_WORKSPACE_SOURCE,
    OTHER_WORKSPACE_PROJECT,
    'Other workspace source',
    'normal',
    'active',
    null,
    null,
    OTHER_WORKSPACE,
  );

  await insertChunk(database, SHARED, 'enterprise GEO shared evidence', QUERY_VECTOR, {
    headings: ['Evidence'],
    page: 1,
  });
  await insertChunk(database, PROJECT_SOURCE, 'enterprise GEO project evidence', vector(0.9, 0.1));
  await insertChunk(
    database,
    LEXICAL,
    'enterprise GEO enterprise GEO enterprise GEO lexical evidence',
    vector(0, 1),
  );
  await insertChunk(database, VECTOR, 'semantic-only material', QUERY_VECTOR);
  await insertChunk(database, FUTURE, 'enterprise GEO future evidence', QUERY_VECTOR);
  await insertChunk(database, UNTRUSTED, 'enterprise GEO untrusted evidence', QUERY_VECTOR);
  await insertChunk(database, HIDDEN, 'enterprise GEO hidden evidence', QUERY_VECTOR);
  await insertChunk(database, PROCESSING, 'enterprise GEO processing evidence', QUERY_VECTOR);
  await insertChunk(database, EXPIRED, 'enterprise GEO expired evidence', QUERY_VECTOR);
  await insertChunk(
    database,
    OTHER_WORKSPACE_SOURCE,
    'enterprise GEO other workspace evidence',
    QUERY_VECTOR,
  );
  await insertChunk(
    database,
    PROJECT_SOURCE,
    'enterprise GEO inactive evidence',
    QUERY_VECTOR,
    {},
    'inactive',
    1,
  );
}

async function insertSource(
  database: Sql,
  id: string,
  projectId: string | null,
  title: string,
  trustLevel: 'verified' | 'normal' | 'untrusted',
  status: 'active' | 'processing',
  effectiveFrom: string | null = null,
  effectiveTo: string | null = null,
  workspaceId = WORKSPACE,
): Promise<void> {
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
      uri, content_hash, trust_level, effective_from, effective_to, status, created_by
    ) VALUES (
      ${id}, ${TENANT}, ${workspaceId}, ${projectId}, ${title}, 'txt', 'text/plain',
      ${`memory://hybrid/${title.toLowerCase().replaceAll(' ', '-')}`},
      ${createHash('sha256').update(id).digest('hex')}, ${trustLevel}, ${effectiveFrom},
      ${effectiveTo}, ${status}, ${OWNER}
    )
  `;
}

async function insertChunk(
  database: Sql,
  sourceId: string,
  text: string,
  embedding: readonly number[],
  locator: Readonly<Record<string, unknown>> = {},
  status: 'active' | 'inactive' = 'active',
  chunkNo = 0,
): Promise<void> {
  const rows = await database<{ id: string }[]>`
    INSERT INTO source_chunks (
      tenant_id, source_document_id, chunk_no, text, text_hash,
      metadata_json, token_count, status
    )
    SELECT
      source.tenant_id, source.id, ${chunkNo}, ${text},
      ${createHash('sha256').update(text).digest('hex')},
      ${JSON.stringify({ char_end: text.length, char_start: 0, headings: [], schema_version: 'chunk-metadata@1', ...locator })}::text::jsonb,
      ${Math.max(1, text.split(/\s+/u).length)}, ${status}
    FROM source_documents AS source
    WHERE source.id = ${sourceId}
    RETURNING id
  `;
  const chunkId = rows[0]?.id;
  if (!chunkId) throw new Error(`Could not insert hybrid-search chunk for ${sourceId}`);
  await database`
    INSERT INTO embeddings (tenant_id, chunk_id, model_key, dimension, embedding)
    VALUES (${TENANT}, ${chunkId}, ${MODEL_KEY}, 1536, ${`[${embedding.join(',')}]`}::vector)
  `;
}

function vector(first: number, second: number): readonly number[] {
  return Object.freeze([first, second, ...Array<number>(1_534).fill(0)]);
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('Hybrid-search database client was not initialized');
  return value;
}
