import {
  MockEmbeddingProvider,
  ProviderEmbeddingAdapter,
  type EmbeddingConfiguration,
} from '@geo-content-os/adapter-embedding';
import { InMemoryStorageAdapter } from '@geo-content-os/adapter-storage';
import { MaterialParser } from '@geo-content-os/parsers';
import {
  AdapterMaterialLoader,
  EmbeddingStore,
  EmbeddingWorker,
  InMemoryEmbeddingCache,
  IngestWorkerError,
  KnowledgeIngestWorker,
  PostgresIngestStore,
  type IngestParserPort,
  type MalwareScannerPort,
} from '@geo-content-os/worker-knowledge';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { MaterialChunker } from '../../src/modules/knowledge/chunking/material.chunker.js';

const USER = '13000000-0000-4000-8000-000000000040';
const TENANT = '23000000-0000-4000-8000-000000000040';
const WORKSPACE = '33000000-0000-4000-8000-000000000040';
const PROJECT = '43000000-0000-4000-8000-000000000040';
const SOURCE = '53000000-0000-4000-8000-000000000040';
const JOB = '63000000-0000-4000-8000-000000000040';
const EVENT = '73000000-0000-4000-8000-000000000040';
const OBJECT_KEY = `${TENANT}/${WORKSPACE}/sources/source.txt`;
const BODY = new TextEncoder().encode(
  'GEO Content OS keeps source evidence traceable. Every chunk preserves its exact locator.',
);
const HASH = createHash('sha256').update(BODY).digest('hex');
const MODEL_KEY = 'embedding-ingest-test-v1';

const embeddingConfiguration: EmbeddingConfiguration = {
  driver: 'mock',
  maxBatchSize: 8,
  maxInputCharacters: 10_000,
  modelKey: MODEL_KEY,
  timeoutMs: 5_000,
};

describe('ingest worker', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let storage: InMemoryStorageAdapter;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 8 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await seedScope(database);
    await seedSource(database);
    storage = new InMemoryStorageAdapter('ingest-test');
    await storage.putObject({
      body: BODY,
      contentHash: HASH,
      contentType: 'text/plain',
      key: OBJECT_KEY,
    });
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('runs upload, scan, parse, chunk, embed and index exactly once', async () => {
    const database = requireClient(client);
    const worker = createWorker(database, storage, passScanner);

    await expect(worker.run(event())).resolves.toMatchObject({
      attempt: 1,
      disposition: 'processed',
      embedded: 1,
      sourceDocumentId: SOURCE,
    });
    expect(await jobState(database)).toMatchObject({
      attemptCount: 1,
      error: null,
      progress: 100,
      sourceStatus: 'active',
      stage: 'done',
      status: 'succeeded',
    });
    expect(
      await database<{ chunks: number; embeddings: number; searchable: number }[]>`
        SELECT
          (SELECT count(*)::integer FROM source_chunks WHERE source_document_id = ${SOURCE}) AS chunks,
          (SELECT count(*)::integer FROM embeddings) AS embeddings,
          (
            SELECT count(*)::integer FROM source_chunks
            WHERE source_document_id = ${SOURCE}
              AND search_vector @@ plainto_tsquery('simple', 'traceable')
          ) AS searchable
      `,
    ).toEqual([{ chunks: 1, embeddings: 1, searchable: 1 }]);

    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'completed' });
    expect(await jobState(database)).toMatchObject({ attemptCount: 1, status: 'succeeded' });
  });

  it('persists a retryable failure, then resumes idempotently on the next attempt', async () => {
    const database = requireClient(client);
    let scans = 0;
    const scanner: MalwareScannerPort = {
      scan: async () => {
        scans += 1;
        if (scans === 1) {
          throw new IngestWorkerError('MALWARE_SCANNER_UNAVAILABLE', 'Scanner unavailable', {
            retryable: true,
          });
        }
      },
    };
    const worker = createWorker(database, storage, scanner);

    await expect(worker.run(event())).rejects.toMatchObject({
      code: 'MALWARE_SCANNER_UNAVAILABLE',
      retryable: true,
    });
    expect(await jobState(database)).toMatchObject({
      attemptCount: 1,
      progress: 0,
      sourceStatus: 'processing',
      stage: 'queued',
      status: 'queued',
    });
    expect((await jobState(database)).error).toMatchObject({
      code: 'MALWARE_SCANNER_UNAVAILABLE',
      retryable: true,
      schema_version: 'job-error@1',
    });

    await expect(worker.run(event())).resolves.toMatchObject({
      attempt: 2,
      disposition: 'processed',
    });
    expect(await jobState(database)).toMatchObject({ attemptCount: 2, status: 'succeeded' });
  });

  it('fails closed on malware and does not parse or index the source', async () => {
    const database = requireClient(client);
    const worker = createWorker(database, storage, {
      scan: async () => {
        throw new IngestWorkerError('MALWARE_DETECTED', 'Malware detected', { retryable: false });
      },
    });

    await expect(worker.run(event())).rejects.toMatchObject({
      code: 'MALWARE_DETECTED',
      retryable: false,
    });
    expect(await jobState(database)).toMatchObject({
      attemptCount: 1,
      sourceStatus: 'failed',
      stage: 'scan',
      status: 'failed',
    });
    expect(
      await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM source_chunks`,
    ).toEqual([{ count: 0 }]);
  });

  it('returns busy for a concurrent duplicate and lets the lease owner finish', async () => {
    const database = requireClient(client);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = createWorker(database, storage, {
      scan: async () => {
        enter();
        await released;
      },
    });

    const first = worker.run(event());
    await entered;
    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'busy' });
    release();
    await expect(first).resolves.toMatchObject({ disposition: 'processed' });
    expect(await jobState(database)).toMatchObject({ attemptCount: 1, status: 'succeeded' });
  });

  it('rejects a forged workspace before claiming the job', async () => {
    const database = requireClient(client);
    const worker = createWorker(database, storage, passScanner);
    const forged = event();
    const forgedData = {
      ...forged,
      data: { ...forged.data, workspace_id: '33000000-0000-4000-8000-000000000140' },
    };
    await expect(worker.run(forgedData)).rejects.toMatchObject({
      code: 'INGEST_SCOPE_INVALID',
      retryable: false,
    });
    expect(await jobState(database)).toMatchObject({ attemptCount: 0, status: 'queued' });
  });

  it('reclaims a stale running job after a crashed worker lease', async () => {
    const database = requireClient(client);
    await database`
      UPDATE ingest_jobs
      SET status = 'running', attempt_count = 1, stage = 'scan', progress = 15, started_at = now()
      WHERE id = ${JOB}
    `;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const worker = createWorker(database, storage, passScanner, { staleAfterMs: 1_000 });

    await expect(worker.run(event())).resolves.toMatchObject({
      attempt: 2,
      disposition: 'processed',
    });
    expect(await jobState(database)).toMatchObject({ attemptCount: 2, status: 'succeeded' });
  });

  it('preserves existing chunk provenance and terminally rejects non-deterministic output', async () => {
    const database = requireClient(client);
    const conflictingText = 'Existing immutable evidence';
    await database`
      INSERT INTO source_chunks (
        tenant_id, source_document_id, chunk_no, text, text_hash, metadata_json, token_count
      ) VALUES (
        ${TENANT}, ${SOURCE}, 0, ${conflictingText},
        ${createHash('sha256').update(conflictingText).digest('hex')},
        ${JSON.stringify({ char_end: conflictingText.length, char_start: 0, headings: [], schema_version: 'chunk-metadata@1' })}::text::jsonb,
        3
      )
    `;
    const worker = createWorker(database, storage, passScanner);

    await expect(worker.run(event())).rejects.toMatchObject({
      code: 'CHUNK_PROVENANCE_CONFLICT',
      retryable: false,
    });
    expect(await jobState(database)).toMatchObject({ sourceStatus: 'failed', status: 'failed' });
    expect(
      await database<
        { text: string }[]
      >`SELECT text FROM source_chunks WHERE source_document_id = ${SOURCE}`,
    ).toEqual([{ text: conflictingText }]);
  });

  it('turns the fifth retryable dependency failure into a terminal failure', async () => {
    const database = requireClient(client);
    await database`UPDATE ingest_jobs SET attempt_count = 4 WHERE id = ${JOB}`;
    const worker = createWorker(database, storage, {
      scan: async () => {
        throw new IngestWorkerError('MALWARE_SCANNER_UNAVAILABLE', 'Scanner unavailable', {
          retryable: true,
        });
      },
    });

    await expect(worker.run(event())).rejects.toMatchObject({ retryable: true });
    expect(await jobState(database)).toMatchObject({
      attemptCount: 5,
      sourceStatus: 'failed',
      status: 'failed',
    });
    expect((await jobState(database)).error).toMatchObject({ retryable: false });
  });
});

const passScanner: MalwareScannerPort = { scan: async () => undefined };

function createWorker(
  database: Sql,
  objectStorage: InMemoryStorageAdapter,
  scanner: MalwareScannerPort,
  options: { readonly staleAfterMs?: number } = {},
): KnowledgeIngestWorker {
  const parser = new MaterialParser();
  const parserPort: IngestParserPort = {
    parse: (source, material) =>
      parser.parse({
        body: material.body,
        contentHash: material.contentHash,
        language: source.language,
        mimeType: material.mimeType,
        sourceType: source.sourceType,
        title: source.title,
        ...(material.url ? { url: material.url } : {}),
      }),
  };
  return new KnowledgeIngestWorker(
    new PostgresIngestStore(database, options.staleAfterMs),
    new AdapterMaterialLoader(objectStorage, {
      fetch: async () => {
        throw new Error('Web fetch must not run for file ingestion');
      },
    }),
    scanner,
    parserPort,
    new MaterialChunker(),
    new EmbeddingWorker(
      new EmbeddingStore(database),
      new InMemoryEmbeddingCache(),
      new ProviderEmbeddingAdapter(embeddingConfiguration, new MockEmbeddingProvider()),
    ),
  );
}

function event() {
  return {
    aggregate: { id: SOURCE, type: 'source_document' },
    data: {
      content_hash: HASH,
      ingest_job_id: JOB,
      object_key: OBJECT_KEY,
      source_document_id: SOURCE,
      workspace_id: WORKSPACE,
    },
    event_id: EVENT,
    event_type: 'knowledge.source.ingest_requested.v1',
    occurred_at: '2026-07-14T00:00:00.000Z',
    tenant: { id: TENANT },
  } as const;
}

async function seedScope(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status)
    VALUES (${USER}, 'ingest-owner@example.com', 'Ingest Owner', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${TENANT}, 'Ingest Tenant', 'ingest-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES (${TENANT}, ${USER}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES (${WORKSPACE}, ${TENANT}, 'Ingest Workspace', 'ingest-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES (${PROJECT}, ${TENANT}, ${WORKSPACE}, 'Ingest Project', ${USER})
  `;
}

async function seedSource(database: Sql): Promise<void> {
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
      uri, content_hash, status, created_by
    ) VALUES (
      ${SOURCE}, ${TENANT}, ${WORKSPACE}, ${PROJECT}, 'Ingest source', 'txt', 'text/plain',
      ${`memory://ingest-test/${OBJECT_KEY}`}, ${HASH}, 'processing', ${USER}
    )
  `;
  await database`
    INSERT INTO ingest_jobs (id, tenant_id, source_document_id)
    VALUES (${JOB}, ${TENANT}, ${SOURCE})
  `;
}

async function jobState(database: Sql) {
  const rows = await database<
    {
      attemptCount: number;
      error: Record<string, unknown> | null;
      progress: number;
      sourceStatus: string;
      stage: string;
      status: string;
    }[]
  >`
    SELECT
      job.attempt_count AS "attemptCount",
      job.error_json AS error,
      job.progress,
      source.status AS "sourceStatus",
      job.stage,
      job.status
    FROM ingest_jobs AS job
    JOIN source_documents AS source ON source.id = job.source_document_id
    WHERE job.id = ${JOB}
  `;
  const row = rows[0];
  if (!row) throw new Error('Ingest job state was not found');
  return row;
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('Ingest integration database client was not initialized');
  return value;
}
