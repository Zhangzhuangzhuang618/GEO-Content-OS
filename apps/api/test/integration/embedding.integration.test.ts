import {
  MockEmbeddingProvider,
  ProviderEmbeddingAdapter,
  type EmbeddingConfiguration,
} from '@geo-content-os/adapter-embedding';
import {
  EmbeddingStore,
  EmbeddingWorker,
  RedisEmbeddingCache,
} from '@geo-content-os/worker-knowledge';
import {
  redisUrl,
  startPostgresTestContainer,
  startRedisTestContainer,
  type StartedPostgreSqlContainer,
  type StartedTestContainer,
} from '@geo-content-os/testkit';
import { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';

const USER = '12000000-0000-4000-8000-000000000035';
const TENANT = '22000000-0000-4000-8000-000000000035';
const OTHER_TENANT = '22000000-0000-4000-8000-000000000135';
const WORKSPACE = '32000000-0000-4000-8000-000000000035';
const PROJECT = '42000000-0000-4000-8000-000000000035';
const SOURCE = '52000000-0000-4000-8000-000000000035';
const MODEL_KEY = 'embedding-test-v1';

const configuration: EmbeddingConfiguration = {
  driver: 'mock',
  maxBatchSize: 2,
  maxInputCharacters: 10_000,
  modelKey: MODEL_KEY,
  timeoutMs: 5_000,
};

describe('embedding worker', () => {
  let client: Sql | undefined;
  let postgresContainer: StartedPostgreSqlContainer | undefined;
  let redisContainer: StartedTestContainer | undefined;
  let redis: Redis | undefined;

  beforeAll(async () => {
    [postgresContainer, redisContainer] = await Promise.all([
      startPostgresTestContainer(),
      startRedisTestContainer(),
    ]);
    await migrateDatabase(postgresContainer.getConnectionUri());
    client = postgres(postgresContainer.getConnectionUri(), { max: 4 });
    redis = new Redis(redisUrl(redisContainer), { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await requireRedis(redis).flushdb();
    await seed(database);
  });

  afterAll(async () => {
    redis?.disconnect();
    await client?.end();
    await Promise.all([postgresContainer?.stop(), redisContainer?.stop()]);
  });

  it('batches, resumes after provider failure, and reuses tenant-scoped Redis cache', async () => {
    const database = requireClient(client);
    const provider = new MockEmbeddingProvider({ failOnCall: 2 });
    const worker = new EmbeddingWorker(
      new EmbeddingStore(database),
      new RedisEmbeddingCache(requireRedis(redis), 3_600),
      new ProviderEmbeddingAdapter(configuration, provider),
    );

    await expect(
      worker.run({
        requestId: 'req-embedding-worker-0001',
        sourceDocumentId: SOURCE,
        tenantId: TENANT,
      }),
    ).rejects.toMatchObject({ code: 'EMBEDDING_PROVIDER_FAILED', retryable: true });
    expect(await embeddingCount(database)).toBe(2);

    const resumed = await worker.run({
      requestId: 'req-embedding-worker-0002',
      sourceDocumentId: SOURCE,
      tenantId: TENANT,
    });
    expect(resumed).toMatchObject({ embedded: 3, providerCalls: 2, selected: 3 });
    expect(await embeddingCount(database)).toBe(5);
    expect(
      await database<{ dimensions: number }[]>`
        SELECT DISTINCT vector_dims(embedding)::integer AS dimensions FROM embeddings
      `,
    ).toEqual([{ dimensions: 1536 }]);

    await database`DELETE FROM embeddings`;
    const cached = await worker.run({
      requestId: 'req-embedding-worker-0003',
      sourceDocumentId: SOURCE,
      tenantId: TENANT,
    });
    expect(cached).toMatchObject({ cacheHits: 5, embedded: 5, providerCalls: 0, selected: 5 });
    expect(await embeddingCount(database)).toBe(5);
  });

  it('does not cross tenants and rejects a poisoned chunk hash before cache/provider use', async () => {
    const database = requireClient(client);
    const worker = new EmbeddingWorker(
      new EmbeddingStore(database),
      new RedisEmbeddingCache(requireRedis(redis), 3_600),
      new ProviderEmbeddingAdapter(configuration, new MockEmbeddingProvider()),
    );

    expect(
      await worker.run({
        requestId: 'req-embedding-worker-0004',
        sourceDocumentId: SOURCE,
        tenantId: OTHER_TENANT,
      }),
    ).toMatchObject({ selected: 0 });

    await database`
      UPDATE source_chunks
      SET text_hash = ${'f'.repeat(64)}
      WHERE id = (
        SELECT id FROM source_chunks
        WHERE source_document_id = ${SOURCE}
        ORDER BY chunk_no
        LIMIT 1
      )
    `;
    await expect(
      worker.run({
        requestId: 'req-embedding-worker-0005',
        sourceDocumentId: SOURCE,
        tenantId: TENANT,
      }),
    ).rejects.toThrow(/text hash does not match/u);
    expect(await embeddingCount(database)).toBe(0);
  });
});

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status)
    VALUES (${USER}, 'embedding-owner@example.com', 'Embedding Owner', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${TENANT}, 'Embedding Tenant', 'embedding-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES (${TENANT}, ${USER}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES (${WORKSPACE}, ${TENANT}, 'Embedding Workspace', 'embedding-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES (${PROJECT}, ${TENANT}, ${WORKSPACE}, 'Embedding Project', ${USER})
  `;
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
      uri, content_hash, status, created_by
    ) VALUES (
      ${SOURCE}, ${TENANT}, ${WORKSPACE}, ${PROJECT}, 'Embedding source', 'txt', 'text/plain',
      'memory://embedding/source', ${'a'.repeat(64)}, 'processing', ${USER}
    )
  `;
  for (let index = 0; index < 5; index += 1) {
    const text = `Embedding evidence chunk ${index}`;
    await database`
      INSERT INTO source_chunks (
        tenant_id, source_document_id, chunk_no, text, text_hash, metadata_json, token_count
      ) VALUES (
        ${TENANT}, ${SOURCE}, ${index}, ${text},
        ${createHash('sha256').update(text).digest('hex')},
        ${JSON.stringify({ char_end: text.length, char_start: 0, headings: [], schema_version: 'chunk-metadata@1' })}::text::jsonb,
        4
      )
    `;
  }
}

async function embeddingCount(database: Sql): Promise<number> {
  const rows = await database<
    { count: number }[]
  >`SELECT count(*)::integer AS count FROM embeddings`;
  return rows[0]?.count ?? 0;
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('Embedding integration database client was not initialized');
  return value;
}

function requireRedis(value: Redis | undefined): Redis {
  if (!value) throw new Error('Embedding integration Redis client was not initialized');
  return value;
}
