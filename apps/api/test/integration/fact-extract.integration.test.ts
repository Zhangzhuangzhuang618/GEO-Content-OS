import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  FactExtractionProvenanceError,
  FactExtractionScopeError,
  FactExtractionService,
  FactExtractionValidationError,
} from '../../src/modules/knowledge/index.js';

const USER = '18000000-0000-4000-8000-000000000038';
const TENANT = '28000000-0000-4000-8000-000000000038';
const OTHER_TENANT = '28000000-0000-4000-8000-000000000138';
const WORKSPACE = '38000000-0000-4000-8000-000000000038';
const OTHER_WORKSPACE = '38000000-0000-4000-8000-000000000138';
const SOURCE = '58000000-0000-4000-8000-000000000038';
const SECOND_SOURCE = '58000000-0000-4000-8000-000000000138';
const FAILED_SOURCE = '58000000-0000-4000-8000-000000000238';

const FIRST_TEXT =
  '星云系统于2025年9月正式上市，首发价格为人民币 9,999 元（含税），仅适用于中国大陆。';
const SECOND_TEXT = '官方复核：首发价格为人民币 9,999 元（含税），仅适用于中国大陆。';

describe('candidate fact extraction', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 8 });
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

  it('stores candidate facts with exact, hash-verified source provenance', async () => {
    const service = new FactExtractionService(requireClient(client));
    const objectValue = '人民币 9,999 元（含税），仅适用于中国大陆';
    const result = await service.extract({
      candidate_facts: [
        {
          confidence: 0.912345,
          object_value: objectValue,
          predicate: '首发价格',
          source_chunk_no: 0,
          subject: '星云系统',
        },
        {
          confidence: 0.8,
          object_value: '2025年9月',
          predicate: '上市时间',
          source_chunk_no: 0,
          subject: '星云系统',
        },
        {
          confidence: 0.7,
          object_value: objectValue,
          predicate: '首发价格',
          source_chunk_no: 0,
          subject: '星云系统',
        },
      ],
      sourceDocumentId: SOURCE,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
    });

    expect(result).toMatchObject({
      acceptedCandidates: 2,
      createdFacts: 2,
      createdSources: 2,
      inputCandidates: 3,
      sourceDocumentId: SOURCE,
    });
    expect(result.facts).toHaveLength(2);
    expect(result.facts.find((fact) => fact.predicate === '首发价格')).toMatchObject({
      confidence: 0.9123,
      created: true,
      objectValue,
      sourceAdded: true,
      status: 'candidate',
    });

    const evidence = await requireClient(client)<
      { confidence: string; quoteHash: string; quoteText: string; status: string }[]
    >`
      SELECT
        fact.confidence::text AS confidence,
        fact.status,
        evidence.quote_text AS "quoteText",
        evidence.quote_hash AS "quoteHash"
      FROM facts AS fact
      JOIN fact_sources AS evidence
        ON evidence.fact_id = fact.id AND evidence.tenant_id = fact.tenant_id
      WHERE fact.predicate = '首发价格'
    `;
    expect(evidence).toEqual([
      {
        confidence: '0.9123',
        quoteHash: sha256(objectValue),
        quoteText: objectValue,
        status: 'candidate',
      },
    ]);
    expect(FIRST_TEXT.includes(evidence[0]?.quoteText ?? '')).toBe(true);
  });

  it('is idempotent and appends a second source to the same active fact', async () => {
    const service = new FactExtractionService(requireClient(client));
    const candidate = {
      confidence: 0.8,
      object_value: '人民币 9,999 元（含税），仅适用于中国大陆',
      predicate: '首发价格',
      source_chunk_no: 0,
      subject: '星云系统',
    };
    const first = await service.extract(extractionInput(SOURCE, candidate));
    const replay = await service.extract(
      extractionInput(SOURCE, { ...candidate, confidence: 0.95 }),
    );
    const second = await service.extract(extractionInput(SECOND_SOURCE, candidate));

    expect(first.facts[0]).toMatchObject({ created: true, sourceAdded: true });
    expect(replay.facts[0]).toMatchObject({
      confidence: 0.95,
      created: false,
      factId: first.facts[0]?.factId,
      factSourceId: first.facts[0]?.factSourceId,
      sourceAdded: false,
    });
    expect(second.facts[0]).toMatchObject({
      created: false,
      factId: first.facts[0]?.factId,
      sourceAdded: true,
    });
    expect(await counts(requireClient(client))).toEqual({ facts: 1, sources: 2 });
  });

  it('serializes concurrent retries without duplicate facts or sources', async () => {
    const input = extractionInput(SOURCE, {
      confidence: 0.88,
      object_value: '2025年9月',
      predicate: '上市时间',
      source_chunk_no: 0,
      subject: '星云系统',
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        new FactExtractionService(requireClient(client)).extract(input),
      ),
    );

    expect(results.flatMap((result) => result.facts).filter((fact) => fact.created)).toHaveLength(
      1,
    );
    expect(
      results.flatMap((result) => result.facts).filter((fact) => fact.sourceAdded),
    ).toHaveLength(1);
    expect(await counts(requireClient(client))).toEqual({ facts: 1, sources: 1 });
  });

  it('fails closed for forged or non-extractable source scopes', async () => {
    const service = new FactExtractionService(requireClient(client));
    const candidate = {
      confidence: 0.8,
      object_value: '2025年9月',
      predicate: '上市时间',
      source_chunk_no: 0,
      subject: '星云系统',
    };

    await expect(
      service.extract({ ...extractionInput(SOURCE, candidate), tenantId: OTHER_TENANT }),
    ).rejects.toBeInstanceOf(FactExtractionScopeError);
    await expect(
      service.extract({ ...extractionInput(SOURCE, candidate), workspaceId: OTHER_WORKSPACE }),
    ).rejects.toBeInstanceOf(FactExtractionScopeError);
    await expect(service.extract(extractionInput(FAILED_SOURCE, candidate))).rejects.toBeInstanceOf(
      FactExtractionScopeError,
    );
    expect(await counts(requireClient(client))).toEqual({ facts: 0, sources: 0 });
  });

  it('rolls back the whole batch when chunk provenance is missing, poisoned, or ungrounded', async () => {
    const database = requireClient(client);
    const service = new FactExtractionService(database);
    await expect(
      service.extract({
        ...extractionInput(SOURCE, {
          confidence: 0.8,
          object_value: '2025年9月',
          predicate: '上市时间',
          source_chunk_no: 0,
          subject: '星云系统',
        }),
        candidate_facts: [
          {
            confidence: 0.8,
            object_value: '2025年9月',
            predicate: '上市时间',
            source_chunk_no: 0,
            subject: '星云系统',
          },
          {
            confidence: 0.8,
            object_value: '不存在的原文',
            predicate: '虚构字段',
            source_chunk_no: 0,
            subject: '星云系统',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(FactExtractionProvenanceError);
    expect(await counts(database)).toEqual({ facts: 0, sources: 0 });

    await expect(
      service.extract(
        extractionInput(SOURCE, {
          confidence: 0.8,
          object_value: '不可用分块',
          predicate: '状态',
          source_chunk_no: 1,
          subject: '星云系统',
        }),
      ),
    ).rejects.toBeInstanceOf(FactExtractionProvenanceError);

    await database`UPDATE source_chunks SET text_hash = ${'f'.repeat(64)} WHERE source_document_id = ${SOURCE}::uuid AND chunk_no = 0`;
    await expect(
      service.extract(
        extractionInput(SOURCE, {
          confidence: 0.8,
          object_value: '2025年9月',
          predicate: '上市时间',
          source_chunk_no: 0,
          subject: '星云系统',
        }),
      ),
    ).rejects.toBeInstanceOf(FactExtractionProvenanceError);
    expect(await counts(database)).toEqual({ facts: 0, sources: 0 });
  });

  it('rejects malformed structured output before opening a persistence path', async () => {
    const service = new FactExtractionService(requireClient(client));
    await expect(
      service.extract(
        extractionInput(SOURCE, {
          confidence: 1.01,
          object_value: '2025年9月',
          predicate: '上市时间',
          source_chunk_no: 0,
          subject: '星云系统',
        }),
      ),
    ).rejects.toBeInstanceOf(FactExtractionValidationError);
    await expect(
      service.extract({
        ...extractionInput(SOURCE, {
          confidence: 0.8,
          object_value: '2025年9月',
          predicate: '上市时间',
          source_chunk_no: 0,
          subject: '星云系统',
        }),
        unexpected: true,
      }),
    ).rejects.toBeInstanceOf(FactExtractionValidationError);
    expect(await counts(requireClient(client))).toEqual({ facts: 0, sources: 0 });
  });
});

function extractionInput(sourceDocumentId: string, candidate: object): object {
  return {
    candidate_facts: [candidate],
    sourceDocumentId,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
  };
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status)
    VALUES (${USER}, 'fact-extract@example.com', 'Fact Extractor', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${TENANT}, 'Fact Tenant', 'fact-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES (${TENANT}, ${USER}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES (${WORKSPACE}, ${TENANT}, 'Fact Workspace', 'fact-workspace', 'Asia/Shanghai')
  `;
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, title, source_type, mime_type, uri,
      content_hash, trust_level, status, created_by
    ) VALUES
      (${SOURCE}, ${TENANT}, ${WORKSPACE}, 'Primary fact source', 'txt', 'text/plain', 'memory://facts/primary', ${'1'.repeat(64)}, 'normal', 'processing', ${USER}),
      (${SECOND_SOURCE}, ${TENANT}, ${WORKSPACE}, 'Secondary fact source', 'txt', 'text/plain', 'memory://facts/secondary', ${'2'.repeat(64)}, 'verified', 'active', ${USER}),
      (${FAILED_SOURCE}, ${TENANT}, ${WORKSPACE}, 'Failed fact source', 'txt', 'text/plain', 'memory://facts/failed', ${'3'.repeat(64)}, 'normal', 'failed', ${USER})
  `;
  await insertChunk(database, SOURCE, 0, FIRST_TEXT, 'active');
  await insertChunk(database, SOURCE, 1, '不可用分块', 'inactive');
  await insertChunk(database, SECOND_SOURCE, 0, SECOND_TEXT, 'active');
}

async function insertChunk(
  database: Sql,
  sourceDocumentId: string,
  chunkNo: number,
  text: string,
  status: 'active' | 'inactive',
): Promise<void> {
  await database`
    INSERT INTO source_chunks (
      tenant_id, source_document_id, chunk_no, text, text_hash,
      metadata_json, token_count, status
    ) VALUES (
      ${TENANT},
      ${sourceDocumentId},
      ${chunkNo},
      ${text},
      ${sha256(text)},
      ${JSON.stringify({ char_end: text.length, char_start: 0, schema_version: 'chunk-metadata@1' })}::text::jsonb,
      20,
      ${status}
    )
  `;
}

async function counts(database: Sql): Promise<{ facts: number; sources: number }> {
  const [row] = await database<{ facts: number; sources: number }[]>`
    SELECT
      (SELECT count(*)::integer FROM facts) AS facts,
      (SELECT count(*)::integer FROM fact_sources) AS sources
  `;
  if (!row) throw new Error('Count query returned no row');
  return row;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('PostgreSQL test client was not initialized');
  return value;
}
