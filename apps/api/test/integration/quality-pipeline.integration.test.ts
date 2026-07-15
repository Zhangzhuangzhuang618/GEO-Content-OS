import type {
  QualityCategory,
  QualityCheckerData,
  QualityIssue,
  QualitySeverity,
} from '@geo-content-os/contracts/skills';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  calculateGeoTotal,
  QualityPipelineRepository,
  QualityPipelineService,
  type QualityEvaluationInput,
  type QualityEvaluatorPort,
  type QualityPipelineRequest,
} from '../../src/modules/quality/pipeline/index.js';

const USER_ID = '1b000000-0000-4000-8000-000000000055';
const OTHER_USER_ID = '1c000000-0000-4000-8000-000000000055';
const TENANT_ID = '2b000000-0000-4000-8000-000000000055';
const WORKSPACE_ID = '3b000000-0000-4000-8000-000000000055';
const PROJECT_ID = '4b000000-0000-4000-8000-000000000055';
const BRIEF_ID = '5b000000-0000-4000-8000-000000000055';
const PACKAGE_ID = '6b000000-0000-4000-8000-000000000055';
const VARIANT_ID = '7b000000-0000-4000-8000-000000000055';
const FACT_RUN_ID = '8b000000-0000-4000-8000-000000000055';
const QUALITY_RUN_ID = '9b000000-0000-4000-8000-000000000055';
const FACT_PROMPT_ID = 'ab000000-0000-4000-8000-000000000055';
const QUALITY_PROMPT_ID = 'bb000000-0000-4000-8000-000000000055';
const BRAND_PROFILE_ID = 'cb000000-0000-4000-8000-000000000055';
const CONTENT_VERSION_ID = 'db000000-0000-4000-8000-000000000055';
const BLOCKED_CONTENT_VERSION_ID = 'eb000000-0000-4000-8000-000000000055';
const PLATFORM_RULE_VERSION_ID = 'fb000000-0000-4000-8000-000000000055';
const SCOPE = {
  generationRunId: QUALITY_RUN_ID,
  projectId: PROJECT_ID,
  tenantId: TENANT_ID,
  userId: USER_ID,
  variantId: VARIANT_ID,
  workspaceId: WORKSPACE_ID,
} as const;
const GEO_SCORES = Object.freeze({
  answerability: 85,
  entity: 90,
  evidence: 95,
  platform_fit: 80,
  question: 75,
  readability_safety: 90,
  total: calculateGeoTotal({
    answerability: 85,
    entity: 90,
    evidence: 95,
    platform_fit: 80,
    question: 75,
    readability_safety: 90,
  }),
});

describe('GEO scoring and Quality pipeline', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 8 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE quality_reports, fact_evidences, fact_check_results, ai_citations, content_block_locks, content_blocks, content_versions, content_variants, content_packages, fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('persists all quality dimensions, the frozen GEO total, pass status, run state, and audit', async () => {
    const database = requireClient(client);
    const issues = (
      ['fact', 'brand', 'compliance', 'format', 'duplicate', 'readability', 'security'] as const
    ).map((category, index) => issue(category, 'INFO', index));
    const evaluator = new FakeQualityEvaluator(assessment(issues));
    const service = new QualityPipelineService(new QualityPipelineRepository(database), evaluator);

    const report = await service.run(SCOPE, request());

    expect(report).toMatchObject({
      checkerVersion: '1.0.0',
      contentVersionId: CONTENT_VERSION_ID,
      decision: 'pass',
      geoScores: GEO_SCORES,
      score: 92,
      variantStatus: 'quality_passed',
      variantVersion: 2,
    });
    expect(new Set(report.issues.map((item) => item.category))).toEqual(
      new Set(issues.map((item) => item.category)),
    );
    expect(evaluator.lastInput).toMatchObject({
      brand_policy: { brand_profile_id: BRAND_PROFILE_ID, version: 1 },
      content_version: { content_version_id: CONTENT_VERSION_ID, variant_id: VARIANT_ID },
      duplicate_matches: [],
      fact_results: [],
      geo_result: { scores: GEO_SCORES },
      platform_rules: { platform_code: 'wechat_mp', version_id: PLATFORM_RULE_VERSION_ID },
    });
    expect(
      await database<{ auditCount: number; reportCount: number; runStatus: string }[]>`
        SELECT
          (SELECT count(*)::integer FROM quality_reports) AS "reportCount",
          (SELECT count(*)::integer FROM audit_events WHERE action = 'content.variant.quality_checked') AS "auditCount",
          (SELECT status FROM generation_runs WHERE id = ${QUALITY_RUN_ID}) AS "runStatus"
      `,
    ).toEqual([{ auditCount: 1, reportCount: 1, runStatus: 'succeeded' }]);
  });

  it('adds mandatory fact, brand, and hard-format blockers before the final gate', async () => {
    const database = requireClient(client);
    await insertUnsupportedHighRiskFact(database);
    await replaceCurrentContent(
      database,
      BLOCKED_CONTENT_VERSION_ID,
      `${'超'.repeat(70)}`,
      'This paragraph promises guaranteed results.',
    );
    const evaluator = new FakeQualityEvaluator(assessment([]));
    const service = new QualityPipelineService(new QualityPipelineRepository(database), evaluator);

    const report = await service.run(
      SCOPE,
      request({ contentVersionId: BLOCKED_CONTENT_VERSION_ID }),
    );

    expect(report.decision).toBe('block');
    expect(report.variantStatus).toBe('quality_failed');
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_id: 'fact.high_risk.unsupported', severity: 'BLOCK' }),
        expect.objectContaining({ rule_id: 'wechat_mp.title.max_length', severity: 'BLOCK' }),
        expect.objectContaining({ rule_id: 'brand.banned_phrase', severity: 'BLOCK' }),
      ]),
    );
  });

  it('returns revise when warnings exceed the configured tenant threshold', async () => {
    const database = requireClient(client);
    const warnings = Array.from({ length: 6 }, (_, index) => issue('readability', 'WARN', index));
    const service = new QualityPipelineService(
      new QualityPipelineRepository(database),
      new FakeQualityEvaluator(assessment(warnings)),
    );

    const report = await service.run(SCOPE, request());

    expect(report).toMatchObject({ decision: 'revise', variantStatus: 'quality_failed' });
  });

  it('replays one immutable report without reevaluation and preserves scope checks', async () => {
    const database = requireClient(client);
    const evaluator = new FakeQualityEvaluator(assessment([]));
    const service = new QualityPipelineService(new QualityPipelineRepository(database), evaluator);
    const first = await service.run(SCOPE, request());
    const replay = await service.run(SCOPE, request({ checkerVersion: ' 1.0.0 ' }));

    expect(replay.id).toBe(first.id);
    expect(evaluator.calls).toBe(1);
    await expect(service.run({ ...SCOPE, userId: OTHER_USER_ID }, request())).rejects.toMatchObject(
      { code: 'QUALITY_SCOPE_NOT_FOUND' },
    );
    await expect(service.run(SCOPE, request({ checkerVersion: '1.0.1' }))).rejects.toMatchObject({
      code: 'QUALITY_IDEMPOTENCY_CONFLICT',
    });
  });

  it('rejects invalid GEO weights and protects persisted reports from mutation', async () => {
    const database = requireClient(client);
    const evaluator = new FakeQualityEvaluator(assessment([]));
    const service = new QualityPipelineService(new QualityPipelineRepository(database), evaluator);
    await expect(
      service.run(SCOPE, request({ geoScores: { ...GEO_SCORES, total: GEO_SCORES.total + 1 } })),
    ).rejects.toMatchObject({ code: 'QUALITY_INPUT_INVALID' });
    expect(evaluator.calls).toBe(0);

    const report = await service.run(SCOPE, request());
    await expect(
      database`UPDATE quality_reports SET score = 0 WHERE id = ${report.id}::uuid`,
    ).rejects.toThrow(/append-only/);
    await expect(
      database`DELETE FROM quality_reports WHERE id = ${report.id}::uuid`,
    ).rejects.toThrow(/append-only/);
  });
});

class FakeQualityEvaluator implements QualityEvaluatorPort {
  public calls = 0;
  public lastInput: QualityEvaluationInput | undefined;

  public constructor(private readonly result: QualityCheckerData) {}

  public async evaluate(
    invocation: Parameters<QualityEvaluatorPort['evaluate']>[0],
  ): Promise<QualityCheckerData> {
    this.calls += 1;
    this.lastInput = invocation.input;
    return this.result;
  }
}

function assessment(issues: readonly QualityIssue[]): QualityCheckerData {
  return Object.freeze({
    decision: 'pass',
    geo_scores: GEO_SCORES,
    issues: Object.freeze([...issues]),
    score: 92,
  });
}

function issue(category: QualityCategory, severity: QualitySeverity, index: number): QualityIssue {
  return Object.freeze({
    category,
    citation_ids: Object.freeze([]),
    location: null,
    message: `${category} check ${index}`,
    rule_id: `${category}.test.${index}`,
    severity,
    suggestion: null,
  });
}

function request(overrides: Partial<QualityPipelineRequest> = {}): QualityPipelineRequest {
  return {
    brandProfileId: BRAND_PROFILE_ID,
    checkerVersion: '1.0.0',
    contentVersionId: CONTENT_VERSION_ID,
    duplicateMatches: [],
    expectedVariantVersion: 1,
    factCheckGenerationRunId: FACT_RUN_ID,
    geoScores: GEO_SCORES,
    platformRules: {
      platform_code: 'wechat_mp',
      rules: { title_max_length: 64 },
      rules_hash: '4'.repeat(64),
      version_id: PLATFORM_RULE_VERSION_ID,
    },
    requestId: 'req-quality-pipeline-0001',
    safetyPolicy: {
      block_on_data_leakage: true,
      block_on_injection: true,
      max_warnings_for_pass: 5,
    },
    ...overrides,
  };
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status)
    VALUES (${USER_ID}, 'quality@example.com', 'Quality Editor', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${TENANT_ID}, 'Quality Tenant', 'quality-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES (${TENANT_ID}, ${USER_ID}, 'content_editor', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES (${WORKSPACE_ID}, ${TENANT_ID}, 'Quality Workspace', 'quality-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES (${PROJECT_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 'Quality Project', ${USER_ID})
  `;
  await database`
    INSERT INTO brand_profiles (
      id, tenant_id, workspace_id, version, status, schema_version,
      profile_json, created_by, published_at
    ) VALUES (
      ${BRAND_PROFILE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 1, 'published', 'brand-profile@1',
      ${JSON.stringify({
        audience: ['Enterprise marketing leaders'],
        banned: ['guaranteed results'],
        compliance: ['Cite verified sources for factual claims'],
        cta: 'Request an evidence-led assessment',
        differentiators: ['Traceable citations'],
        positioning: 'Evidence-led enterprise content',
        tone: 'Professional and direct',
      })}::text::jsonb,
      ${USER_ID}, now()
    )
  `;
  await database`
    INSERT INTO briefs (
      id, tenant_id, workspace_id, project_id, title, objective, audience,
      platform_codes, constraints_json, created_by
    ) VALUES (
      ${BRIEF_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Quality Brief',
      'trust', 'Enterprise marketing leaders',
      ARRAY['wechat_mp']::varchar[], '{"schema_version":"brief-constraints@1"}'::jsonb, ${USER_ID}
    )
  `;
  await database`
    INSERT INTO content_packages (
      id, tenant_id, workspace_id, project_id, brief_id, created_by
    ) VALUES (${PACKAGE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${BRIEF_ID}, ${USER_ID})
  `;
  await database`
    INSERT INTO content_variants (id, tenant_id, package_id, platform_code, status)
    VALUES (${VARIANT_ID}, ${TENANT_ID}, ${PACKAGE_ID}, 'wechat_mp', 'generated')
  `;
  await insertContentVersion(
    database,
    CONTENT_VERSION_ID,
    1,
    '企业 GEO 内容生产指南',
    '内容基于可追溯资料。',
  );
  await database`
    UPDATE content_variants SET current_content_version_id = ${CONTENT_VERSION_ID}
    WHERE id = ${VARIANT_ID}
  `;
  await database`
    INSERT INTO generation_runs (
      id, tenant_id, workspace_id, project_id, package_id, variant_id,
      skill_name, skill_version, prompt_version_id, model_key, status,
      input_hash, request_id, started_at
    ) VALUES
      (
        ${FACT_RUN_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${PACKAGE_ID}, ${VARIANT_ID},
        'fact-checker', '1.0.0', ${FACT_PROMPT_ID}, 'deepseek-pro', 'running',
        ${'1'.repeat(64)}, 'req-quality-fact-run', now()
      ),
      (
        ${QUALITY_RUN_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${PACKAGE_ID}, ${VARIANT_ID},
        'quality-checker', '1.0.0', ${QUALITY_PROMPT_ID}, 'deepseek-pro', 'running',
        ${'2'.repeat(64)}, 'req-quality-run', now()
      )
  `;
}

async function replaceCurrentContent(
  database: Sql,
  contentVersionId: string,
  title: string,
  text: string,
): Promise<void> {
  await insertContentVersion(database, contentVersionId, 2, title, text);
  await database`
    UPDATE content_variants SET current_content_version_id = ${contentVersionId}
    WHERE id = ${VARIANT_ID}
  `;
}

async function insertContentVersion(
  database: Sql,
  contentVersionId: string,
  versionNo: number,
  title: string,
  text: string,
): Promise<void> {
  const value = {
    blocks: [{ block_key: 'intro', block_type: 'paragraph', text }],
    citation_map: [],
    cta: null,
    hashtags: [],
    platform_code: 'wechat_mp',
    platform_meta: {},
    schema_version: 'content-writer-data@1',
    summary: 'A quality pipeline fixture.',
    title,
  };
  await database`
    INSERT INTO content_versions (
      id, tenant_id, package_id, variant_id, version_no, schema_version,
      content_json, content_hash, created_by
    ) VALUES (
      ${contentVersionId}, ${TENANT_ID}, ${PACKAGE_ID}, ${VARIANT_ID}, ${versionNo},
      'content-writer-data@1', ${JSON.stringify(value)}::text::jsonb,
      ${sha256(JSON.stringify(value))}, ${USER_ID}
    )
  `;
}

async function insertUnsupportedHighRiskFact(database: Sql): Promise<void> {
  await database`
    INSERT INTO fact_check_results (
      tenant_id, generation_run_id, variant_id, claim_key, claim_text,
      claim_hash, verdict, risk_level, confidence, reason
    ) VALUES (
      ${TENANT_ID}, ${FACT_RUN_ID}, ${VARIANT_ID}, 'market-leader', '产品市场占有率第一',
      ${sha256('产品市场占有率第一')}, 'unsupported', 'critical', 0.1, 'No authoritative evidence'
    )
  `;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Quality pipeline PostgreSQL client was not initialized');
  return client;
}
