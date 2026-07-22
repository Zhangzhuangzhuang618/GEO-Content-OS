import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import { type WebFetchAdapter, WebFetchBlockedError } from '@geo-content-os/adapter-web-fetch';
import {
  minioEndpoint,
  MINIO_TEST_ACCESS_KEY,
  MINIO_TEST_SECRET_KEY,
  startMinioTestContainer,
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
  type StartedTestContainer,
} from '@geo-content-os/testkit';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplication } from '../../src/application.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import {
  SOURCE_STORAGE,
  SOURCE_WEB_FETCH,
  SourceNotFoundError,
  SourceService,
  SourceStorageError,
  type ParsedSourceUpload,
} from '../../src/modules/knowledge/index.js';
import { OutboxWriter } from '../../src/modules/outbox/index.js';

const MANAGER_ID = '10000000-0000-4000-8000-000000000030';
const SCOPED_ID = '10000000-0000-4000-8000-000000000130';
const VIEWER_ID = '10000000-0000-4000-8000-000000000230';
const TENANT_ID = '20000000-0000-4000-8000-000000000030';
const WORKSPACE_ID = '30000000-0000-4000-8000-000000000030';
const PROJECT_A = '40000000-0000-4000-8000-000000000030';
const PROJECT_B = '40000000-0000-4000-8000-000000000130';
const API_PATH = '/api/v1/sources';

describe('source upload', () => {
  let application: NestFastifyApplication | undefined;
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let minio: StartedTestContainer | undefined;
  beforeAll(async () => {
    [container, minio] = await Promise.all([
      startPostgresTestContainer(),
      startMinioTestContainer(),
    ]);
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 6 });
    setEnvironment('DATABASE_URL', container.getConnectionUri());
    setEnvironment('NODE_ENV', 'test');
    setEnvironment('S3_ACCESS_KEY_ID', MINIO_TEST_ACCESS_KEY);
    setEnvironment('S3_AUTO_CREATE_BUCKET', 'true');
    setEnvironment('S3_BUCKET', 'geo-source-integration');
    setEnvironment('S3_ENDPOINT', minioEndpoint(minio));
    setEnvironment('S3_FORCE_PATH_STYLE', 'true');
    setEnvironment('S3_REGION', 'us-east-1');
    setEnvironment('S3_SECRET_ACCESS_KEY', MINIO_TEST_SECRET_KEY);
    setEnvironment('S3_SERVER_SIDE_ENCRYPTION', 'false');
    setEnvironment('SOURCE_UPLOAD_MAX_BYTES', '64');
    setEnvironment('STORAGE_DRIVER', 's3');
    application = await createApplication({
      enableShutdownHooks: false,
      logger: false,
      securityConfiguration: {
        allowedOrigins: ['https://app.example.com'],
        environment: 'test',
        production: false,
        rateLimit: { max: 1_000, timeWindowMs: 60_000 },
        trustProxy: false,
      },
    });
    await application.init();
    await application.getHttpAdapter().getInstance().ready();
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await seedScope(database);
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await Promise.all([container?.stop(), minio?.stop()]);
    for (const [name, value] of originalEnvironmentGlobal) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('connects the runtime adapter to a private S3-compatible MinIO bucket', async () => {
    const storage = requireStorage(application);
    expect(storage.constructor.name).toBe('S3StorageAdapter');
    const body = Buffer.from('storage smoke', 'utf8');
    const contentHash = sha256(body);
    const key = `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/sources/${contentHash}.txt`;
    await storage.putObject({
      body,
      contentHash,
      contentType: 'text/plain',
      key,
      metadata: {
        content_hash: contentHash,
        source_id: randomUUID(),
        tenant_id: TENANT_ID,
        workspace_id: WORKSPACE_ID,
      },
    });
    expect(await storage.headObject(key)).toMatchObject({ contentLength: body.byteLength });
    await storage.deleteObject(key);
  });

  it('stores one private object and atomically creates source, ingest job, outbox, and audit', async () => {
    const database = requireClient(client);
    const tokens = await createSession(database, MANAGER_ID);
    const body = Buffer.from('Enterprise GEO trusted source', 'utf8');
    const first = await sendUpload(application, tokens, 'source-upload-001', body);
    const replay = await sendUpload(application, tokens, 'source-upload-001', body);

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.data.source.id).toBe(first.body.data.source.id);
    expect(first.body.data).toMatchObject({
      ingest_job: {
        progress: 0,
        stage: 'queued',
        status: 'queued',
        tenant_id: TENANT_ID,
      },
      source: {
        content_hash: sha256(body),
        mime_type: 'text/plain',
        project_id: PROJECT_A,
        source_type: 'txt',
        status: 'processing',
        tenant_id: TENANT_ID,
        trust_level: 'verified',
        workspace_id: WORKSPACE_ID,
      },
    });

    expect(
      await database<{ sources: number; jobs: number; events: number; audits: number }[]>`
        SELECT
          (SELECT count(*)::integer FROM source_documents) AS sources,
          (SELECT count(*)::integer FROM ingest_jobs) AS jobs,
          (SELECT count(*)::integer FROM outbox_events) AS events,
          (SELECT count(*)::integer FROM audit_events WHERE action = 'knowledge.source.uploaded') AS audits
      `,
    ).toEqual([{ audits: 1, events: 1, jobs: 1, sources: 1 }]);
    const event = await database<
      { eventType: string; jobId: string; sourceId: string; status: string }[]
    >`
      SELECT
        event_type AS "eventType",
        payload_json->'data'->>'ingest_job_id' AS "jobId",
        payload_json->'data'->>'source_document_id' AS "sourceId",
        status
      FROM outbox_events
    `;
    expect(event).toEqual([
      {
        eventType: 'knowledge.source.ingest_requested.v1',
        jobId: first.body.data.ingest_job.id,
        sourceId: first.body.data.source.id,
        status: 'pending',
      },
    ]);

    const storage = requireStorage(application);
    const objectKey = `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/sources/${sha256(body)}.txt`;
    expect(await storage.headObject(objectKey)).toMatchObject({
      contentLength: body.byteLength,
      contentType: 'text/plain',
      metadata: { content_hash: sha256(body) },
    });
    const download = await fetch(await storage.createDownloadUrl(objectKey, 60));
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(body);
    const source = await database<{ uri: string }[]>`SELECT uri FROM source_documents`;
    expect(source[0]?.uri).toBe(`s3://geo-source-integration/${objectKey}`);
  });

  it('serves the complete source and ingest-job API lifecycle with scope, role, audit, and outbox enforcement', async () => {
    const database = requireClient(client);
    const manager = await createSession(database, MANAGER_ID);
    const viewer = await createSession(database, VIEWER_ID);
    const body = Buffer.from('Knowledge lifecycle source', 'utf8');
    const upload = await sendUpload(application, manager, 'source-lifecycle-001', body);
    expect(upload.status).toBe(201);
    const sourceId = String(upload.body.data.source.id);
    const originalJobId = String(upload.body.data.ingest_job.id);
    const scopeQuery = `workspace_id=${WORKSPACE_ID}&project_id=${PROJECT_A}`;

    const listed = await authenticatedRequest(application, viewer).get(`${API_PATH}?${scopeQuery}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body).toMatchObject({
      data: [{ id: sourceId, title: 'Enterprise source' }],
      meta: { next_cursor: null, request_id: expect.any(String) },
    });

    const detail = await authenticatedRequest(application, viewer).get(
      `${API_PATH}/${sourceId}?${scopeQuery}`,
    );
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.data).toMatchObject({
      chunks: [],
      citation_count: 0,
      facts: [],
      ingest_jobs: [{ id: originalJobId }],
      source: { id: sourceId },
    });

    const job = await authenticatedRequest(application, viewer).get(
      `/api/v1/ingest-jobs/${originalJobId}?${scopeQuery}`,
    );
    expect(job.status).toBe(200);
    expect(job.body.data).toMatchObject({ id: originalJobId, source_document_id: sourceId });
    const hidden = await authenticatedRequest(application, viewer).get(
      `${API_PATH}/${sourceId}?workspace_id=${WORKSPACE_ID}&project_id=${PROJECT_B}`,
    );
    expectApiError(hidden, 404, 'RESOURCE_NOT_FOUND');

    await database`
      UPDATE ingest_jobs
      SET status = 'succeeded', attempt_count = 1, stage = 'done', progress = 100,
        started_at = now() - interval '1 second', finished_at = now(), updated_at = now()
      WHERE id = ${originalJobId}::uuid
    `;
    await database`
      UPDATE source_documents SET status = 'active', updated_at = now()
      WHERE id = ${sourceId}::uuid
    `;
    const chunkId = randomUUID();
    const factId = randomUUID();
    const quote = '标准退款周期为 30 天';
    await database`
      INSERT INTO source_chunks (
        id, tenant_id, source_document_id, chunk_no, text, text_hash, metadata_json, token_count
      ) VALUES (
        ${chunkId}::uuid, ${TENANT_ID}::uuid, ${sourceId}::uuid, 0, ${quote}, ${sha256(quote)},
        ${JSON.stringify({ char_end: quote.length, char_start: 0, schema_version: 'chunk-metadata@1' })}::text::jsonb,
        8
      )
    `;
    await database`
      INSERT INTO facts (
        id, tenant_id, workspace_id, subject, predicate, object_value, confidence
      ) VALUES (
        ${factId}::uuid, ${TENANT_ID}::uuid, ${WORKSPACE_ID}::uuid,
        '标准服务', '退款周期', '30 天', 0.9800
      )
    `;
    await database`
      INSERT INTO fact_sources (tenant_id, fact_id, chunk_id, quote_text, quote_hash)
      VALUES (${TENANT_ID}::uuid, ${factId}::uuid, ${chunkId}::uuid, ${quote}, ${sha256(quote)})
    `;
    const facts = await authenticatedRequest(application, viewer).get(
      `/api/v1/facts?${scopeQuery}&status=candidate&search=${encodeURIComponent('退款')}`,
    );
    expect(facts.status, JSON.stringify(facts.body)).toBe(200);
    expect(facts.body.data).toMatchObject([
      {
        evidence: [{ chunk_id: chunkId, source_document_id: sourceId }],
        id: factId,
        object_value: '30 天',
        predicate: '退款周期',
      },
    ]);
    const detailedEvidence = await authenticatedRequest(application, viewer).get(
      `${API_PATH}/${sourceId}?${scopeQuery}`,
    );
    expect(detailedEvidence.body.data).toMatchObject({
      chunks: [{ id: chunkId, metadata: { char_start: 0, char_end: quote.length } }],
      citation_count: 0,
      facts: [{ id: factId }],
    });
    const denied = await authenticatedRequest(application, viewer)
      .post(`${API_PATH}/${sourceId}/reindex`)
      .send({ expected_content_hash: sha256(body), reason: 'viewer cannot reindex' });
    expectApiError(denied, 403, 'PERMISSION_DENIED');

    const reindex = await authenticatedRequest(application, manager)
      .post(`${API_PATH}/${sourceId}/reindex`)
      .send({ expected_content_hash: sha256(body), reason: 'refresh embeddings' });
    expect(reindex.status, JSON.stringify(reindex.body)).toBe(202);
    expect(reindex.body.data).toMatchObject({
      source_document_id: sourceId,
      stage: 'queued',
      status: 'queued',
    });
    expect(reindex.body.data.id).not.toBe(originalJobId);

    const afterReindex = await authenticatedRequest(application, manager).get(
      `${API_PATH}/${sourceId}?${scopeQuery}`,
    );
    expect(afterReindex.status).toBe(200);
    const revision = String(afterReindex.body.data.source.updated_at);
    const removed = await authenticatedRequest(application, manager)
      .delete(`${API_PATH}/${sourceId}`)
      .set('If-Match', `"${revision}"`)
      .send({ reason: 'source superseded' });
    expect(removed.status, removed.text).toBe(204);

    const absent = await authenticatedRequest(application, viewer).get(
      `${API_PATH}/${sourceId}?${scopeQuery}`,
    );
    expectApiError(absent, 404, 'RESOURCE_NOT_FOUND');
    expect(
      await database<
        { audits: number; events: number; jobs: number; sourceStatus: string; deleted: boolean }[]
      >`
        SELECT
          (SELECT count(*)::integer FROM audit_events WHERE resource_id = ${sourceId}::uuid) AS audits,
          (SELECT count(*)::integer FROM outbox_events WHERE aggregate_id = ${sourceId}::uuid) AS events,
          (SELECT count(*)::integer FROM ingest_jobs WHERE source_document_id = ${sourceId}::uuid) AS jobs,
          source.status AS "sourceStatus",
          source.deleted_at IS NOT NULL AS deleted
        FROM source_documents AS source WHERE source.id = ${sourceId}::uuid
      `,
    ).toEqual([{ audits: 3, deleted: true, events: 2, jobs: 2, sourceStatus: 'expired' }]);
  });

  it('enforces content-hash and idempotency conflicts without duplicate side effects', async () => {
    const database = requireClient(client);
    const tokens = await createSession(database, MANAGER_ID);
    const body = Buffer.from('same source content', 'utf8');
    expect((await sendUpload(application, tokens, 'source-upload-002', body)).status).toBe(201);
    const duplicate = await sendUpload(application, tokens, 'source-upload-003', body);
    expectApiError(duplicate, 409, 'STATE_TRANSITION_INVALID');
    const changed = await sendUpload(
      application,
      tokens,
      'source-upload-002',
      Buffer.from('different source content', 'utf8'),
    );
    expectApiError(changed, 409, 'IDEMPOTENCY_CONFLICT');
    expect(
      await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM source_documents`,
    ).toEqual([{ count: 1 }]);
  });

  it('serializes concurrent hash duplicates so only one source and object win', async () => {
    const database = requireClient(client);
    const tokens = await createSession(database, MANAGER_ID);
    const body = Buffer.from('concurrent source content', 'utf8');
    const [first, second] = await Promise.all([
      sendUpload(application, tokens, 'source-upload-concurrent-a', body),
      sendUpload(application, tokens, 'source-upload-concurrent-b', body),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect([first.body.error?.code, second.body.error?.code]).toContain('STATE_TRANSITION_INVALID');
    expect(
      await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM source_documents`,
    ).toEqual([{ count: 1 }]);
    const objectKey = `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/sources/${sha256(body)}.txt`;
    expect(await requireStorage(application).headObject(objectKey)).toMatchObject({
      contentLength: body.byteLength,
      contentType: 'text/plain',
    });
  });

  it('validates signatures, upload limits, dates, and required multipart shape', async () => {
    const database = requireClient(client);
    const tokens = await createSession(database, MANAGER_ID);
    const spoofed = await sendUpload(
      application,
      tokens,
      'source-upload-004',
      Buffer.from('not a pdf', 'utf8'),
      { contentType: 'application/pdf', filename: 'source.pdf' },
    );
    expectApiError(spoofed, 422, 'SCHEMA_VALIDATION_FAILED');
    const oversized = await sendUpload(
      application,
      tokens,
      'source-upload-005',
      Buffer.alloc(65, 0x61),
    );
    expectApiError(oversized, 422, 'SCHEMA_VALIDATION_FAILED');
    const badDate = await sendUpload(
      application,
      tokens,
      'source-upload-006',
      Buffer.from('valid text', 'utf8'),
      { effectiveFrom: '2026-02-30' },
    );
    expectApiError(badDate, 422, 'SCHEMA_VALIDATION_FAILED');
    expect(
      await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM source_documents`,
    ).toEqual([{ count: 0 }]);
  });

  it('enforces role and live project scope while hiding forged project IDs', async () => {
    const database = requireClient(client);
    const viewer = await createSession(database, VIEWER_ID);
    const denied = await sendUpload(
      application,
      viewer,
      'source-upload-007',
      Buffer.from('viewer source', 'utf8'),
    );
    expectApiError(denied, 403, 'PERMISSION_DENIED');

    const scoped = await createSession(database, SCOPED_ID);
    expect(
      (
        await sendUpload(
          application,
          scoped,
          'source-upload-008',
          Buffer.from('project a source', 'utf8'),
        )
      ).status,
    ).toBe(201);
    const projectB = await sendUpload(
      application,
      scoped,
      'source-upload-009',
      Buffer.from('project b source', 'utf8'),
      { projectId: PROJECT_B },
    );
    expectApiError(projectB, 404, 'RESOURCE_NOT_FOUND');
    const shared = await sendUpload(
      application,
      scoped,
      'source-upload-010',
      Buffer.from('shared source', 'utf8'),
      { projectId: null },
    );
    expectApiError(shared, 404, 'RESOURCE_NOT_FOUND');
    expect(
      await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM source_documents`,
    ).toEqual([{ count: 1 }]);
  });

  it('revalidates service-layer permissions and rolls back every database side effect on storage failure', async () => {
    const database = requireClient(client);
    let putCalls = 0;
    const failingStorage: ObjectStorageAdapter = {
      createDownloadUrl: async () => 'https://storage.invalid/unreachable',
      deleteObject: async () => undefined,
      getObject: async () => {
        throw new Error('simulated unavailable storage');
      },
      headObject: async () => undefined,
      objectUri: (key) => `s3://failing-storage/${key}`,
      putObject: async () => {
        putCalls += 1;
        throw new Error('simulated unavailable storage');
      },
    };
    const service = new SourceService(new OutboxWriter(database), failingStorage);
    const input = sourceInput(Buffer.from('service-layer source', 'utf8'));

    await expect(
      database.begin((transaction) =>
        service.upload(transaction, TENANT_ID, VIEWER_ID, input, { requestId: randomUUID() }),
      ),
    ).rejects.toBeInstanceOf(SourceNotFoundError);
    expect(putCalls).toBe(0);

    await expect(
      database.begin((transaction) =>
        service.upload(transaction, TENANT_ID, MANAGER_ID, input, { requestId: randomUUID() }),
      ),
    ).rejects.toBeInstanceOf(SourceStorageError);
    expect(putCalls).toBe(1);
    expect(
      await database<{ sources: number; jobs: number; events: number; audits: number }[]>`
        SELECT
          (SELECT count(*)::integer FROM source_documents) AS sources,
          (SELECT count(*)::integer FROM ingest_jobs) AS jobs,
          (SELECT count(*)::integer FROM outbox_events) AS events,
          (SELECT count(*)::integer FROM audit_events) AS audits
      `,
    ).toEqual([{ audits: 0, events: 0, jobs: 0, sources: 0 }]);
  });

  it('registers a safely fetched URL and preserves the fetched bytes as its ingest snapshot', async () => {
    const database = requireClient(client);
    const tokens = await createSession(database, MANAGER_ID);
    const body = Buffer.from('<html><body>canonical evidence</body></html>', 'utf8');
    const webFetch = requireApplication(application).get<WebFetchAdapter>(SOURCE_WEB_FETCH);
    const fetch = vi.spyOn(webFetch, 'fetch').mockResolvedValue({
      body,
      contentHash: sha256(body),
      contentType: 'text/html',
      finalUrl: 'https://www.example.com/canonical',
      redirectChain: ['https://www.example.com/canonical'],
      statusCode: 200,
    });
    try {
      const response = await sendUrl(
        application,
        tokens,
        'source-url-001',
        'https://example.com/original#fragment',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.data.source).toMatchObject({
        content_hash: sha256(body),
        mime_type: 'text/html',
        source_type: 'url',
        status: 'processing',
      });
      expect(fetch).toHaveBeenCalledWith('https://example.com/original#fragment');
      const sourceId = String(response.body.data.source.id);
      const objectKey = `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/sources/${sourceId}/${sha256(body)}.url`;
      const rows = await database<
        { event: Record<string, unknown>; sourceType: string; uri: string }[]
      >`
        SELECT
          source.source_type AS "sourceType",
          source.uri,
          event.payload_json->'data' AS event
        FROM source_documents AS source
        JOIN outbox_events AS event ON event.aggregate_id = source.id
      `;
      expect(rows).toEqual([
        {
          event: expect.objectContaining({
            content_hash: sha256(body),
            object_key: objectKey,
            redirect_chain: ['https://www.example.com/canonical'],
            source_url: 'https://www.example.com/canonical',
          }),
          sourceType: 'url',
          uri: 'https://www.example.com/canonical',
        },
      ]);
      expect(await requireStorage(application).headObject(objectKey)).toMatchObject({
        contentLength: body.byteLength,
        contentType: 'text/html',
        metadata: { content_hash: sha256(body), source_id: sourceId },
      });
    } finally {
      fetch.mockRestore();
    }
  });

  it('refreshes a failed legacy URL snapshot before creating its reindex job', async () => {
    const database = requireClient(client);
    const tokens = await createSession(database, MANAGER_ID);
    const firstBody = Buffer.from('<html><body>dynamic token one</body></html>', 'utf8');
    const refreshedBody = Buffer.from('<html><body>dynamic token two</body></html>', 'utf8');
    const webFetch = requireApplication(application).get<WebFetchAdapter>(SOURCE_WEB_FETCH);
    const fetch = vi
      .spyOn(webFetch, 'fetch')
      .mockResolvedValueOnce({
        body: firstBody,
        contentHash: sha256(firstBody),
        contentType: 'text/html',
        finalUrl: 'https://www.example.com/dynamic',
        redirectChain: ['https://www.example.com/dynamic'],
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        body: refreshedBody,
        contentHash: sha256(refreshedBody),
        contentType: 'text/html',
        finalUrl: 'https://www.example.com/dynamic',
        redirectChain: ['https://www.example.com/dynamic'],
        statusCode: 200,
      });
    try {
      const created = await sendUrl(
        application,
        tokens,
        'source-url-refresh-001',
        'https://example.com/dynamic',
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const sourceId = String(created.body.data.source.id);
      const oldKey = `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/sources/${sourceId}/${sha256(firstBody)}.url`;
      await requireStorage(application).deleteObject(oldKey);
      await database`
        UPDATE ingest_jobs
        SET
          status = 'failed', attempt_count = 1, stage = 'upload', progress = 5,
          error_json = '{"code":"SOURCE_CONTENT_CHANGED","message":"legacy","schema_version":"job-error@1"}'::jsonb,
          started_at = now() - interval '1 second', finished_at = now(), updated_at = now()
        WHERE source_document_id = ${sourceId}::uuid
      `;
      await database`
        UPDATE source_documents SET status = 'failed', updated_at = now()
        WHERE id = ${sourceId}::uuid
      `;

      const reindex = await authenticatedRequest(application, tokens)
        .post(`${API_PATH}/${sourceId}/reindex`)
        .send({
          expected_content_hash: sha256(firstBody),
          reason: 'repair legacy URL snapshot',
        });
      expect(reindex.status, JSON.stringify(reindex.body)).toBe(202);
      const refreshedHash = sha256(refreshedBody);
      const refreshedKey = `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/sources/${sourceId}/${refreshedHash}.url`;
      expect(
        await database<
          { contentHash: string; event: Record<string, unknown>; sourceStatus: string }[]
        >`
          SELECT
            source.content_hash AS "contentHash",
            source.status AS "sourceStatus",
            event.payload_json->'data' AS event
          FROM source_documents AS source
          JOIN outbox_events AS event ON event.aggregate_id = source.id
          WHERE source.id = ${sourceId}::uuid
          ORDER BY event.created_at DESC
          LIMIT 1
        `,
      ).toEqual([
        {
          contentHash: refreshedHash,
          event: expect.objectContaining({
            content_hash: refreshedHash,
            object_key: refreshedKey,
            source_url: 'https://www.example.com/dynamic',
          }),
          sourceStatus: 'processing',
        },
      ]);
      expect(await requireStorage(application).headObject(refreshedKey)).toMatchObject({
        contentLength: refreshedBody.byteLength,
      });
    } finally {
      fetch.mockRestore();
    }
  });

  it('rejects a repeated final URL even when the fetched response content changes', async () => {
    const database = requireClient(client);
    const tokens = await createSession(database, MANAGER_ID);
    const firstBody = Buffer.from('<html><body>first response</body></html>', 'utf8');
    const secondBody = Buffer.from('<html><body>changed response</body></html>', 'utf8');
    const webFetch = requireApplication(application).get<WebFetchAdapter>(SOURCE_WEB_FETCH);
    const fetch = vi
      .spyOn(webFetch, 'fetch')
      .mockResolvedValueOnce({
        body: firstBody,
        contentHash: sha256(firstBody),
        contentType: 'text/html',
        finalUrl: 'https://www.example.com/one-source',
        redirectChain: ['https://www.example.com/one-source'],
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        body: secondBody,
        contentHash: sha256(secondBody),
        contentType: 'text/html',
        finalUrl: 'https://www.example.com/one-source',
        redirectChain: ['https://www.example.com/one-source'],
        statusCode: 200,
      });
    try {
      const first = await sendUrl(
        application,
        tokens,
        'source-url-unique-001',
        'https://example.com/source',
      );
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expectApiError(
        await sendUrl(application, tokens, 'source-url-unique-002', 'https://example.com/source'),
        409,
        'STATE_TRANSITION_INVALID',
      );
      expect(
        await database<{ count: number }[]>`
          SELECT count(*)::integer AS count FROM source_documents
        `,
      ).toEqual([{ count: 1 }]);
    } finally {
      fetch.mockRestore();
    }
  });

  it('previews a CSV URL batch without writing source records', async () => {
    const database = requireClient(client);
    const tokens = await createSession(database, MANAGER_ID);
    const response = await authenticatedRequest(application, tokens)
      .post(`${API_PATH}/batch-url-preview`)
      .field('url_column', 'D')
      .field('start_row', '2')
      .attach('file', Buffer.from('a,b,c,url\n,,,https://e.co\n', 'utf8'), {
        contentType: 'text/csv',
        filename: 'urls.csv',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      data: {
        duplicate_rows: 0,
        invalid_rows: 0,
        ready_rows: 1,
        rows: [{ row_number: 2, status: 'ready', url: 'https://e.co/' }],
        sheet_name: 'CSV',
        total_rows: 1,
      },
      meta: { request_id: expect.any(String) },
    });
    expect(
      await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM source_documents`,
    ).toEqual([{ count: 0 }]);
  });

  it('maps SSRF blocks and ambiguous file-plus-url submissions to validation errors without side effects', async () => {
    const database = requireClient(client);
    const tokens = await createSession(database, MANAGER_ID);
    const webFetch = requireApplication(application).get<WebFetchAdapter>(SOURCE_WEB_FETCH);
    const fetch = vi.spyOn(webFetch, 'fetch').mockRejectedValue(new WebFetchBlockedError());
    try {
      expectApiError(
        await sendUrl(application, tokens, 'source-url-002', 'http://169.254.169.254/latest'),
        422,
        'SCHEMA_VALIDATION_FAILED',
      );
    } finally {
      fetch.mockRestore();
    }
    const ambiguous = await request(requireApplication(application).getHttpServer())
      .post(API_PATH)
      .set('Cookie', `geo_session=${tokens.session}; geo_csrf=${tokens.csrf}`)
      .set('idempotency-key', 'source-url-003')
      .set('x-csrf-token', tokens.csrf)
      .field('workspace_id', WORKSPACE_ID)
      .field('project_id', PROJECT_A)
      .field('title', 'Ambiguous source')
      .field('url', 'https://example.com')
      .attach('file', Buffer.from('file body'), {
        contentType: 'text/plain',
        filename: 'source.txt',
      });
    expectApiError(ambiguous, 422, 'SCHEMA_VALIDATION_FAILED');
    expect(
      await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM source_documents`,
    ).toEqual([{ count: 0 }]);
  });
});

async function seedScope(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status)
    VALUES
      (${MANAGER_ID}, 'source-manager@example.com', 'Source Manager', 'active'),
      (${SCOPED_ID}, 'source-scoped@example.com', 'Source Scoped', 'active'),
      (${VIEWER_ID}, 'source-viewer@example.com', 'Source Viewer', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${TENANT_ID}, 'Source Tenant', 'source-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES
      (${TENANT_ID}, ${MANAGER_ID}, 'strategy_editor', 'active'),
      (${TENANT_ID}, ${SCOPED_ID}, 'content_editor', 'active'),
      (${TENANT_ID}, ${VIEWER_ID}, 'viewer', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES (${WORKSPACE_ID}, ${TENANT_ID}, 'Source Workspace', 'source-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES
      (${PROJECT_A}, ${TENANT_ID}, ${WORKSPACE_ID}, 'Source Project A', ${MANAGER_ID}),
      (${PROJECT_B}, ${TENANT_ID}, ${WORKSPACE_ID}, 'Source Project B', ${MANAGER_ID})
  `;
  await database`
    INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
    VALUES (
      ${WORKSPACE_ID},
      ${SCOPED_ID},
      ${JSON.stringify({ project_ids: [PROJECT_A], schema_version: 'workspace-scope@1' })}::text::jsonb
    )
  `;
}

async function createSession(
  database: Sql,
  userId: string,
): Promise<{ readonly csrf: string; readonly session: string }> {
  const session = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  await database`
    INSERT INTO sessions (user_id, active_tenant_id, session_hash, csrf_hash, expires_at)
    VALUES (${userId}, ${TENANT_ID}, ${sha256(session)}, ${sha256(csrf)}, now() + interval '1 hour')
  `;
  return { csrf, session };
}

async function sendUpload(
  value: NestFastifyApplication | undefined,
  tokens: { readonly csrf: string; readonly session: string },
  idempotencyKey: string,
  body: Buffer,
  options: {
    readonly contentType?: string;
    readonly effectiveFrom?: string;
    readonly filename?: string;
    readonly projectId?: string | null;
  } = {},
) {
  const call = request(requireApplication(value).getHttpServer())
    .post(API_PATH)
    .set('Cookie', `geo_session=${tokens.session}; geo_csrf=${tokens.csrf}`)
    .set('idempotency-key', idempotencyKey)
    .set('x-csrf-token', tokens.csrf)
    .field('workspace_id', WORKSPACE_ID)
    .field('title', 'Enterprise source')
    .field('language', 'zh-CN')
    .field('trust_level', 'verified');
  if (options.projectId !== null) call.field('project_id', options.projectId ?? PROJECT_A);
  if (options.effectiveFrom) call.field('effective_from', options.effectiveFrom);
  return call.attach('file', body, {
    contentType: options.contentType ?? 'text/plain',
    filename: options.filename ?? 'source.txt',
  });
}

async function sendUrl(
  value: NestFastifyApplication | undefined,
  tokens: { readonly csrf: string; readonly session: string },
  idempotencyKey: string,
  url: string,
) {
  return request(requireApplication(value).getHttpServer())
    .post(API_PATH)
    .set('Cookie', `geo_session=${tokens.session}; geo_csrf=${tokens.csrf}`)
    .set('idempotency-key', idempotencyKey)
    .set('x-csrf-token', tokens.csrf)
    .field('workspace_id', WORKSPACE_ID)
    .field('project_id', PROJECT_A)
    .field('title', 'Enterprise URL source')
    .field('language', 'zh-CN')
    .field('trust_level', 'verified')
    .field('url', url);
}

function authenticatedRequest(
  value: NestFastifyApplication | undefined,
  tokens: { readonly csrf: string; readonly session: string },
) {
  const server = requireApplication(value).getHttpServer();
  const authenticate = <T extends { set(name: string, value: string): T }>(call: T): T =>
    call
      .set('Cookie', `geo_session=${tokens.session}; geo_csrf=${tokens.csrf}`)
      .set('x-csrf-token', tokens.csrf);
  return {
    delete: (path: string) => authenticate(request(server).delete(path)),
    get: (path: string) => authenticate(request(server).get(path)),
    post: (path: string) => authenticate(request(server).post(path)),
  };
}

function expectApiError(
  response: { readonly body: unknown; readonly status: number },
  status: number,
  code: string,
): void {
  expect(response.status).toBe(status);
  expect(response.body).toMatchObject({
    error: { code, request_id: expect.any(String) },
  });
}

function setEnvironment(name: string, value: string): void {
  if (!originalEnvironmentGlobal.has(name)) originalEnvironmentGlobal.set(name, process.env[name]);
  process.env[name] = value;
}

const originalEnvironmentGlobal = new Map<string, string | undefined>();

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceInput(body: Buffer): ParsedSourceUpload {
  return {
    body,
    contentHash: sha256(body),
    effectiveFrom: null,
    effectiveTo: null,
    extension: 'txt',
    filename: 'service-layer-source.txt',
    kind: 'file',
    language: 'zh-CN',
    mimeType: 'text/plain',
    projectId: PROJECT_A,
    sourceType: 'txt',
    title: 'Service-layer source',
    trustLevel: 'verified',
    workspaceId: WORKSPACE_ID,
  };
}

function requireStorage(value: NestFastifyApplication | undefined): ObjectStorageAdapter {
  return requireApplication(value).get<ObjectStorageAdapter>(SOURCE_STORAGE);
}

function requireApplication(value: NestFastifyApplication | undefined): NestFastifyApplication {
  if (!value) throw new Error('Source upload application was not initialized');
  return value;
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('Source upload database client was not initialized');
  return value;
}
