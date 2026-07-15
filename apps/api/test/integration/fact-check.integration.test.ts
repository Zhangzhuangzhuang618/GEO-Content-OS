import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  FactCheckRepository,
  FactCheckService,
  type FactClaimJudgePort,
  type FactEvidenceCandidate,
  type FactEvidenceSearchPort,
  type NormalizedFactClaim,
  sha256,
} from '../../src/modules/quality/fact-check/index.js';

const USER_ID = '1a000000-0000-4000-8000-000000000054';
const TENANT_ID = '2a000000-0000-4000-8000-000000000054';
const WORKSPACE_ID = '3a000000-0000-4000-8000-000000000054';
const PROJECT_ID = '4a000000-0000-4000-8000-000000000054';
const BRIEF_ID = '5a000000-0000-4000-8000-000000000054';
const PACKAGE_ID = '6a000000-0000-4000-8000-000000000054';
const VARIANT_ID = '7a000000-0000-4000-8000-000000000054';
const RUN_ID = '8a000000-0000-4000-8000-000000000054';
const PROMPT_ID = '9a000000-0000-4000-8000-000000000054';
const SOURCE_ID = 'aa000000-0000-4000-8000-000000000054';
const CHUNK_ID = 'ba000000-0000-4000-8000-000000000054';
const SOURCE_TEXT = '产品于2025年9月上市，并提供企业级GEO内容生产能力。';
const SCOPE = {
  generationRunId: RUN_ID,
  projectId: PROJECT_ID,
  tenantId: TENANT_ID,
  userId: USER_ID,
  variantId: VARIANT_ID,
  workspaceId: WORKSPACE_ID,
} as const;

describe('fact-check result and evidence transaction', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 8 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE fact_evidences, fact_check_results, ai_citations, content_block_locks, content_blocks, content_versions, content_variants, content_packages, fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('normalizes claims, persists supported evidence, and records unsupported without evidence', async () => {
    const database = requireClient(client);
    const search = new FakeEvidenceSearch();
    const judge = new FakeJudge();
    const service = new FactCheckService(new FactCheckRepository(database), search, judge);

    const results = await service.check(SCOPE, {
      claims: [
        { claimKey: 'launch-date', claimText: ' 产品于2025年9月上市 ', riskLevel: 'high' },
        { claimKey: 'market-share', claimText: '产品市场占有率第一', riskLevel: 'critical' },
      ],
      requestId: 'req-fact-check-0001',
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      claimHash: sha256('产品于2025年9月上市'),
      claimText: '产品于2025年9月上市',
      evidences: [
        {
          chunkId: CHUNK_ID,
          quoteText: '产品于2025年9月上市',
          supportLevel: 'supported',
        },
      ],
      verdict: 'supported',
    });
    expect(results[1]).toMatchObject({ evidences: [], verdict: 'unsupported' });
    expect(search.calls).toBe(2);
    expect(judge.calls).toBe(1);
    expect(
      await database<{ evidenceCount: number; resultCount: number }[]>`
        SELECT
          (SELECT count(*)::integer FROM fact_check_results) AS "resultCount",
          (SELECT count(*)::integer FROM fact_evidences) AS "evidenceCount"
      `,
    ).toEqual([{ evidenceCount: 1, resultCount: 2 }]);

    const replay = await service.check(SCOPE, {
      claims: [
        { claimKey: 'launch-date', claimText: '产品于２０２５年９月上市', riskLevel: 'high' },
        { claimKey: 'market-share', claimText: '产品市场占有率第一', riskLevel: 'critical' },
      ],
      requestId: 'req-fact-check-replay',
    });
    expect(replay.map((result) => result.id)).toEqual(results.map((result) => result.id));
    expect(search.calls).toBe(2);
    expect(judge.calls).toBe(1);
  });

  it('serializes concurrent retries to one immutable run result', async () => {
    const database = requireClient(client);
    const service = new FactCheckService(
      new FactCheckRepository(database),
      new FakeEvidenceSearch(),
      new FakeJudge(),
    );
    const request = {
      claims: [{ claimKey: 'launch-date', claimText: '产品于2025年9月上市', riskLevel: 'high' }],
      requestId: 'req-fact-check-concurrent',
    } as const;

    const [first, second] = await Promise.all([
      service.check(SCOPE, request),
      service.check(SCOPE, request),
    ]);
    expect(first[0]?.id).toBe(second[0]?.id);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM fact_check_results
      `,
    ).toEqual([{ count: 1 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM fact_evidences
      `,
    ).toEqual([{ count: 1 }]);
  });

  it('rejects fabricated quotes before opening the persistence transaction', async () => {
    const database = requireClient(client);
    const service = new FactCheckService(
      new FactCheckRepository(database),
      new FakeEvidenceSearch(),
      {
        judge: async () => ({
          confidence: 0.8,
          evidences: [
            {
              chunkId: CHUNK_ID,
              confidence: 0.8,
              quoteText: '资料中不存在的结论',
              supportLevel: 'supported',
            },
          ],
          reason: 'invalid fixture',
          rewriteSuggestion: null,
          verdict: 'supported',
        }),
      },
    );

    await expect(
      service.check(SCOPE, {
        claims: [{ claimKey: 'launch-date', claimText: '产品于2025年9月上市', riskLevel: 'high' }],
        requestId: 'req-fact-check-invalid-quote',
      }),
    ).rejects.toMatchObject({ code: 'FACT_CHECK_JUDGEMENT_INVALID' });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM fact_check_results
      `,
    ).toEqual([{ count: 0 }]);
  });

  it('enforces unsupported cardinality, evidence provenance, and append-only history in PostgreSQL', async () => {
    const database = requireClient(client);
    const service = new FactCheckService(
      new FactCheckRepository(database),
      new EmptyEvidenceSearch(),
      new FakeJudge(),
    );
    const [unsupported] = await service.check(SCOPE, {
      claims: [{ claimKey: 'unsupported', claimText: '没有证据的断言', riskLevel: 'critical' }],
      requestId: 'req-fact-check-db-guards',
    });
    if (!unsupported) throw new Error('Unsupported result fixture was not created');

    await expect(
      database`
        INSERT INTO fact_evidences (
          tenant_id, fact_check_result_id, chunk_id, quote_text,
          quote_hash, support_level, confidence
        ) VALUES (
          ${TENANT_ID}, ${unsupported.id}, ${CHUNK_ID}, '产品于2025年9月上市',
          ${sha256('产品于2025年9月上市')}, 'supported', 1
        )
      `,
    ).rejects.toThrow(/not eligible/);
    await expect(
      database`UPDATE fact_check_results SET reason = 'tampered' WHERE id = ${unsupported.id}::uuid`,
    ).rejects.toThrow(/append-only/);
    await expect(
      database.begin(async (transaction) => {
        await transaction`
          INSERT INTO fact_check_results (
            tenant_id, generation_run_id, variant_id, claim_key, claim_text,
            claim_hash, verdict, risk_level, confidence, reason
          ) VALUES (
            ${TENANT_ID}, ${RUN_ID}, ${VARIANT_ID}, 'missing-evidence', '有支持但无证据',
            ${sha256('有支持但无证据')}, 'supported', 'high', 0.8, 'invalid fixture'
          )
        `;
      }),
    ).rejects.toThrow(/requires evidence/);
  });
});

class FakeEvidenceSearch implements FactEvidenceSearchPort {
  public calls = 0;

  public async search(input: {
    readonly claim: NormalizedFactClaim;
  }): Promise<readonly FactEvidenceCandidate[]> {
    this.calls += 1;
    if (input.claim.claimKey === 'market-share') return [];
    return [
      {
        chunkId: CHUNK_ID,
        factId: null,
        relevanceScore: 0.99,
        sourceDocumentId: SOURCE_ID,
        text: SOURCE_TEXT,
        textHash: sha256(SOURCE_TEXT),
        trustLevel: 'verified',
      },
    ];
  }
}

class EmptyEvidenceSearch implements FactEvidenceSearchPort {
  public async search(): Promise<readonly FactEvidenceCandidate[]> {
    return [];
  }
}

class FakeJudge implements FactClaimJudgePort {
  public calls = 0;

  public async judge(): ReturnType<FactClaimJudgePort['judge']> {
    this.calls += 1;
    return {
      confidence: 0.96,
      evidences: [
        {
          chunkId: CHUNK_ID,
          confidence: 0.96,
          quoteText: '产品于2025年9月上市',
          supportLevel: 'supported',
        },
      ],
      reason: '发布日期与可信资料一致',
      rewriteSuggestion: null,
      verdict: 'supported',
    };
  }
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status)
    VALUES (${USER_ID}, 'fact-check@example.com', 'Fact Check', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${TENANT_ID}, 'Fact Check Tenant', 'fact-check-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES (${TENANT_ID}, ${USER_ID}, 'content_editor', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES (${WORKSPACE_ID}, ${TENANT_ID}, 'Fact Check Workspace', 'fact-check-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES (${PROJECT_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 'Fact Check Project', ${USER_ID})
  `;
  await database`
    INSERT INTO briefs (
      id, tenant_id, workspace_id, project_id, title, objective, audience,
      platform_codes, constraints_json, created_by
    ) VALUES (
      ${BRIEF_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Fact Check Brief', 'trust',
      'Enterprise teams requiring traceable evidence for published claims',
      ARRAY['official_site']::varchar[], '{"schema_version":"brief-constraints@1"}'::jsonb, ${USER_ID}
    )
  `;
  await database`
    INSERT INTO content_packages (
      id, tenant_id, workspace_id, project_id, brief_id, created_by
    ) VALUES (${PACKAGE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${BRIEF_ID}, ${USER_ID})
  `;
  await database`
    INSERT INTO content_variants (id, tenant_id, package_id, platform_code, status)
    VALUES (${VARIANT_ID}, ${TENANT_ID}, ${PACKAGE_ID}, 'official_site', 'generated')
  `;
  await database`
    INSERT INTO generation_runs (
      id, tenant_id, workspace_id, project_id, package_id, variant_id,
      skill_name, skill_version, prompt_version_id, model_key, status,
      input_hash, request_id, started_at
    ) VALUES (
      ${RUN_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${PACKAGE_ID}, ${VARIANT_ID},
      'fact-checker', '1.0.0', ${PROMPT_ID}, 'deepseek-pro', 'running',
      ${'1'.repeat(64)}, 'req-fact-check-run', now()
    )
  `;
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
      language, uri, content_hash, trust_level, status, created_by
    ) VALUES (
      ${SOURCE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, '发布日期资料', 'txt', 'text/plain',
      'zh-CN', 's3://fact-check/source.txt', ${sha256(SOURCE_TEXT)}, 'verified', 'active', ${USER_ID}
    )
  `;
  await database`
    INSERT INTO source_chunks (
      id, tenant_id, source_document_id, chunk_no, text, text_hash,
      metadata_json, token_count, status
    ) VALUES (
      ${CHUNK_ID}, ${TENANT_ID}, ${SOURCE_ID}, 0, ${SOURCE_TEXT}, ${sha256(SOURCE_TEXT)},
      ${JSON.stringify({
        char_end: SOURCE_TEXT.length,
        char_start: 0,
        schema_version: 'chunk-metadata@1',
      })}::text::jsonb,
      30, 'active'
    )
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Fact-check PostgreSQL client was not initialized');
  return client;
}
