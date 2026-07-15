import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  calculateSnapshotHash,
  SubmitReviewService,
  type FrozenSnapshotMaterial,
  type SubmitReviewScope,
} from '../../src/modules/review/submit/index.js';

const USER_ID = '11000000-0000-4000-8000-000000000118';
const OTHER_USER_ID = '12000000-0000-4000-8000-000000000118';
const TENANT_ID = '21000000-0000-4000-8000-000000000118';
const OTHER_TENANT_ID = '22000000-0000-4000-8000-000000000118';
const WORKSPACE_ID = '31000000-0000-4000-8000-000000000118';
const PROJECT_ID = '41000000-0000-4000-8000-000000000118';
const BRAND_PROFILE_ID = '51000000-0000-4000-8000-000000000118';
const BRIEF_ID = '61000000-0000-4000-8000-000000000118';
const PACKAGE_ID = '71000000-0000-4000-8000-000000000118';
const VARIANT_ID = '81000000-0000-4000-8000-000000000118';
const OTHER_VARIANT_ID = '82000000-0000-4000-8000-000000000118';
const CONTENT_VERSION_ID = '91000000-0000-4000-8000-000000000118';
const OTHER_CONTENT_VERSION_ID = '92000000-0000-4000-8000-000000000118';
const QUALITY_RUN_ID = 'a1000000-0000-4000-8000-000000000118';
const OTHER_QUALITY_RUN_ID = 'a2000000-0000-4000-8000-000000000118';
const QUALITY_REPORT_ID = 'b1000000-0000-4000-8000-000000000118';
const OTHER_QUALITY_REPORT_ID = 'b2000000-0000-4000-8000-000000000118';
const PROMPT_VERSION_ID = 'c1000000-0000-4000-8000-000000000118';
const ZHIHU_RULE_ID = 'd1000000-0000-4000-8000-000000000118';
const WECHAT_RULE_ID = 'd2000000-0000-4000-8000-000000000118';
const SOURCE_ID = 'e1000000-0000-4000-8000-000000000118';
const CHUNK_ID = 'f1000000-0000-4000-8000-000000000118';
const CITATION_ID = 'a3000000-0000-4000-8000-000000000118';
const OTHER_CITATION_ID = 'a4000000-0000-4000-8000-000000000118';
const CONTENT_HASH = '1'.repeat(64);
const OTHER_CONTENT_HASH = '2'.repeat(64);
const QUOTE = '提交审核时必须冻结精确内容、规则和引用。';

const SCOPE: SubmitReviewScope = {
  projectId: PROJECT_ID,
  requestId: 'req-review-submit-0001',
  tenantId: TENANT_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

describe('review submission', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`
      TRUNCATE
        review_actions, review_requirements, review_snapshot_citations,
        review_snapshot_variants, review_snapshots, platform_rule_versions,
        prompt_versions, visibility_observations, metric_records, import_jobs,
        export_artifacts, publish_attempts, publish_jobs, media_assets,
        platform_accounts, usage_ledger, quality_reports, fact_evidences,
        fact_check_results, ai_citations, content_block_locks, content_blocks,
        content_versions, content_variants, content_packages, fact_sources, facts,
        embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords,
        briefs, source_documents, topic_candidates, generation_runs, keywords,
        keyword_sets, brand_profiles, workspace_memberships, projects, workspaces,
        audit_events, outbox_events, support_access_grants, idempotency_records,
        password_reset_tokens, invitations, sessions, platform_roles,
        memberships, tenants, users
      CASCADE
    `;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('freezes one selected quality_passed variant and atomically projects review state', async () => {
    const database = requireClient(client);
    const result = await new SubmitReviewService(database).submit(SCOPE, {
      packageId: PACKAGE_ID,
      variantIds: [VARIANT_ID],
    });

    expect(result.replayed).toBe(false);
    expect(result.snapshot).toMatchObject({
      brandProfileId: BRAND_PROFILE_ID,
      modelKey: 'deepseek-pro',
      packageId: PACKAGE_ID,
      promptVersionId: PROMPT_VERSION_ID,
      status: 'in_review',
    });
    expect(result.snapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.snapshot.variants).toMatchObject([
      {
        citations: [
          { aiCitationId: CITATION_ID, citationHash: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        ],
        contentHash: CONTENT_HASH,
        contentVersionId: CONTENT_VERSION_ID,
        platformRuleVersionId: ZHIHU_RULE_ID,
        qualityReportId: QUALITY_REPORT_ID,
        status: 'in_review',
        variantId: VARIANT_ID,
      },
    ]);
    expect(
      await database<{ auditCount: number; packageStatus: string; packageVersion: number }[]>`
        SELECT
          (SELECT count(*)::integer FROM audit_events WHERE action = 'review_snapshot.submitted') AS "auditCount",
          status AS "packageStatus",
          version AS "packageVersion"
        FROM content_packages WHERE id = ${PACKAGE_ID}
      `,
    ).toEqual([{ auditCount: 1, packageStatus: 'in_review', packageVersion: 2 }]);
    expect(
      await database<{ id: string; status: string; version: number }[]>`
        SELECT id, status, version FROM content_variants
        WHERE package_id = ${PACKAGE_ID} ORDER BY id
      `,
    ).toEqual([
      { id: VARIANT_ID, status: 'in_review', version: 2 },
      { id: OTHER_VARIANT_ID, status: 'quality_passed', version: 1 },
    ]);
  });

  it('replays the same deterministic snapshot without duplicate state or audit writes', async () => {
    const database = requireClient(client);
    const service = new SubmitReviewService(database);
    const first = await service.submit(SCOPE, {
      packageId: PACKAGE_ID,
      variantIds: [OTHER_VARIANT_ID, VARIANT_ID],
    });
    const replay = await service.submit(
      { ...SCOPE, requestId: 'req-review-submit-0002' },
      { packageId: PACKAGE_ID, variantIds: [VARIANT_ID, OTHER_VARIANT_ID] },
    );

    expect(replay.replayed).toBe(true);
    expect(replay.snapshot.id).toBe(first.snapshot.id);
    expect(replay.snapshot.snapshotHash).toBe(first.snapshot.snapshotHash);
    expect(
      await database<
        { audits: number; packageVersion: number; snapshots: number; variantVersion: number }[]
      >`
        SELECT
          (SELECT count(*)::integer FROM review_snapshots) AS snapshots,
          (SELECT count(*)::integer FROM audit_events WHERE action = 'review_snapshot.submitted') AS audits,
          (SELECT version FROM content_packages WHERE id = ${PACKAGE_ID}) AS "packageVersion",
          (SELECT version FROM content_variants WHERE id = ${VARIANT_ID}) AS "variantVersion"
      `,
    ).toEqual([{ audits: 1, packageVersion: 2, snapshots: 1, variantVersion: 2 }]);
  });

  it('rejects non-quality-passed input and rolls back every review write', async () => {
    const database = requireClient(client);
    await database`
      UPDATE content_variants SET status = 'quality_failed' WHERE id = ${VARIANT_ID}
    `;

    await expect(
      new SubmitReviewService(database).submit(SCOPE, {
        packageId: PACKAGE_ID,
        variantIds: [VARIANT_ID],
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_STATE_INVALID' });
    expect(
      await database<
        { audits: number; packageStatus: string; snapshots: number; variantStatus: string }[]
      >`
        SELECT
          (SELECT count(*)::integer FROM review_snapshots) AS snapshots,
          (SELECT count(*)::integer FROM audit_events WHERE action = 'review_snapshot.submitted') AS audits,
          (SELECT status FROM content_packages WHERE id = ${PACKAGE_ID}) AS "packageStatus",
          (SELECT status FROM content_variants WHERE id = ${VARIANT_ID}) AS "variantStatus"
      `,
    ).toEqual([
      { audits: 0, packageStatus: 'generated', snapshots: 0, variantStatus: 'quality_failed' },
    ]);
  });

  it('rejects foreign scope, duplicate IDs, and incomplete server rule configuration', async () => {
    const database = requireClient(client);
    const service = new SubmitReviewService(database);
    await expect(
      service.submit(
        { ...SCOPE, tenantId: OTHER_TENANT_ID, userId: OTHER_USER_ID },
        { packageId: PACKAGE_ID, variantIds: [VARIANT_ID] },
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_SCOPE_NOT_FOUND' });
    await expect(
      service.submit(SCOPE, {
        packageId: PACKAGE_ID,
        variantIds: [VARIANT_ID, VARIANT_ID],
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_INPUT_INVALID' });
    await database`
      UPDATE platform_rule_versions SET status = 'retired', published_at = published_at
      WHERE id = ${ZHIHU_RULE_ID}
    `;
    await expect(
      service.submit(SCOPE, { packageId: PACKAGE_ID, variantIds: [VARIANT_ID] }),
    ).rejects.toMatchObject({ code: 'REVIEW_STATE_INVALID' });
    expect(
      await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM review_snapshots`,
    ).toEqual([{ count: 0 }]);
  });

  it('calculates the same snapshot hash regardless of input variant and citation order', () => {
    const material = hashFixture();
    const reversed: FrozenSnapshotMaterial = {
      ...material,
      platformRules: [...material.platformRules].reverse(),
      variants: [...material.variants]
        .reverse()
        .map((variant) => ({ ...variant, citations: [...variant.citations].reverse() })),
    };
    expect(calculateSnapshotHash(reversed)).toBe(calculateSnapshotHash(material));
  });
});

function hashFixture(): FrozenSnapshotMaterial {
  return {
    brandProfileHash: '1'.repeat(64),
    brandProfileId: BRAND_PROFILE_ID,
    modelKey: 'deepseek-pro',
    platformRules: [
      { contentHash: '2'.repeat(64), platformCode: 'zhihu', versionId: ZHIHU_RULE_ID },
      { contentHash: '3'.repeat(64), platformCode: 'wechat_mp', versionId: WECHAT_RULE_ID },
    ],
    platformRulesHash: '4'.repeat(64),
    promptContentHash: '5'.repeat(64),
    promptVersionId: PROMPT_VERSION_ID,
    qualityRulesHash: '6'.repeat(64),
    variants: [
      {
        citations: [
          { aiCitationId: CITATION_ID, citationHash: '7'.repeat(64) },
          { aiCitationId: OTHER_CITATION_ID, citationHash: '8'.repeat(64) },
        ],
        contentHash: CONTENT_HASH,
        contentVersionId: CONTENT_VERSION_ID,
        platformCode: 'zhihu',
        platformRuleVersionId: ZHIHU_RULE_ID,
        qualityReportId: QUALITY_REPORT_ID,
        variantId: VARIANT_ID,
      },
      {
        citations: [],
        contentHash: OTHER_CONTENT_HASH,
        contentVersionId: OTHER_CONTENT_VERSION_ID,
        platformCode: 'wechat_mp',
        platformRuleVersionId: WECHAT_RULE_ID,
        qualityReportId: OTHER_QUALITY_REPORT_ID,
        variantId: OTHER_VARIANT_ID,
      },
    ],
  };
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status) VALUES
      (${USER_ID}, 'submitter@example.com', 'Review Submitter', 'active'),
      (${OTHER_USER_ID}, 'other-submitter@example.com', 'Other Submitter', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status) VALUES
      (${TENANT_ID}, 'Submit Tenant', 'submit-tenant', 'active'),
      (${OTHER_TENANT_ID}, 'Other Submit Tenant', 'other-submit-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status) VALUES
      (${TENANT_ID}, ${USER_ID}, 'content_editor', 'active'),
      (${OTHER_TENANT_ID}, ${OTHER_USER_ID}, 'content_editor', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES (${WORKSPACE_ID}, ${TENANT_ID}, 'Submit Workspace', 'submit-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES (${PROJECT_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 'Submit Project', ${USER_ID})
  `;
  await database`
    INSERT INTO brand_profiles (
      id, tenant_id, workspace_id, version, status, schema_version,
      profile_json, created_by, published_at
    ) VALUES (
      ${BRAND_PROFILE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 1, 'published',
      'brand-profile@1',
      ${database.json({
        audience: ['Enterprise reviewers'],
        banned: ['Unverified claims'],
        compliance: ['Every factual claim needs a citation'],
        cta: 'Request an evidence review',
        differentiators: ['Immutable review snapshots'],
        positioning: 'Evidence-led enterprise content',
        tone: 'Professional and direct',
      })},
      ${USER_ID}, now()
    )
  `;
  await database`
    INSERT INTO briefs (
      id, tenant_id, workspace_id, project_id, title, objective, audience,
      platform_codes, constraints_json, created_by
    ) VALUES (
      ${BRIEF_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Submit Brief',
      'trust', 'Enterprise reviewers', ARRAY['zhihu','wechat_mp']::varchar[],
      '{"schema_version":"brief-constraints@1"}'::jsonb, ${USER_ID}
    )
  `;
  await database`
    INSERT INTO content_packages (
      id, tenant_id, workspace_id, project_id, brief_id, status, created_by
    ) VALUES (
      ${PACKAGE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${BRIEF_ID},
      'generated', ${USER_ID}
    )
  `;
  await database`
    INSERT INTO content_variants (id, tenant_id, package_id, platform_code, status) VALUES
      (${VARIANT_ID}, ${TENANT_ID}, ${PACKAGE_ID}, 'zhihu', 'quality_passed'),
      (${OTHER_VARIANT_ID}, ${TENANT_ID}, ${PACKAGE_ID}, 'wechat_mp', 'quality_passed')
  `;
  await database`
    INSERT INTO content_versions (
      id, tenant_id, package_id, variant_id, version_no, schema_version,
      content_json, content_hash, created_by
    ) VALUES
      (
        ${CONTENT_VERSION_ID}, ${TENANT_ID}, ${PACKAGE_ID}, ${VARIANT_ID}, 1,
        'content-zhihu@1', '{"schema_version":"content-zhihu@1","title":"Zhihu"}'::jsonb,
        ${CONTENT_HASH}, ${USER_ID}
      ),
      (
        ${OTHER_CONTENT_VERSION_ID}, ${TENANT_ID}, ${PACKAGE_ID}, ${OTHER_VARIANT_ID}, 1,
        'content-wechat_mp@1',
        '{"schema_version":"content-wechat_mp@1","title":"Wechat"}'::jsonb,
        ${OTHER_CONTENT_HASH}, ${USER_ID}
      )
  `;
  await database`
    UPDATE content_variants
    SET current_content_version_id = CASE id
      WHEN ${VARIANT_ID}::uuid THEN ${CONTENT_VERSION_ID}::uuid
      ELSE ${OTHER_CONTENT_VERSION_ID}::uuid
    END
    WHERE id IN (${VARIANT_ID}::uuid, ${OTHER_VARIANT_ID}::uuid)
  `;
  await database`
    INSERT INTO prompt_versions (
      id, skill_name, version, schema_version, system_prompt, task_template,
      content_hash, status, created_by, published_at
    ) VALUES (
      ${PROMPT_VERSION_ID}, 'quality-checker', '1.0.0', 'quality-checker-data@1',
      'Evaluate exact content and evidence.', 'Check {{content_version_id}}.',
      ${'3'.repeat(64)}, 'published', ${USER_ID}, now()
    )
  `;
  await database`
    INSERT INTO platform_rule_versions (
      id, platform_code, version, rules_json, content_hash, status, created_by, published_at
    ) VALUES
      (
        ${ZHIHU_RULE_ID}, 'zhihu', '1.0.0',
        '{"schema_version":"platform-rules@1","title_max":100}'::jsonb,
        ${'4'.repeat(64)}, 'published', ${USER_ID}, now()
      ),
      (
        ${WECHAT_RULE_ID}, 'wechat_mp', '1.0.0',
        '{"schema_version":"platform-rules@1","title_max":64}'::jsonb,
        ${'5'.repeat(64)}, 'published', ${USER_ID}, now()
      )
  `;
  await database`
    INSERT INTO generation_runs (
      id, tenant_id, workspace_id, project_id, package_id, variant_id,
      skill_name, skill_version, prompt_version_id, model_key, status,
      input_hash, request_id, started_at, finished_at
    ) VALUES
      (
        ${QUALITY_RUN_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${PACKAGE_ID},
        ${VARIANT_ID}, 'quality-checker', '1.0.0', ${PROMPT_VERSION_ID},
        'deepseek-pro', 'succeeded', ${'6'.repeat(64)}, 'review-quality-run-1', now(), now()
      ),
      (
        ${OTHER_QUALITY_RUN_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${PACKAGE_ID},
        ${OTHER_VARIANT_ID}, 'quality-checker', '1.0.0', ${PROMPT_VERSION_ID},
        'deepseek-pro', 'succeeded', ${'7'.repeat(64)}, 'review-quality-run-2', now(), now()
      )
  `;
  await database`
    INSERT INTO quality_reports (
      id, tenant_id, variant_id, content_version_id, generation_run_id,
      checker_version, score, decision, issues_json, geo_scores_json
    ) VALUES
      (
        ${QUALITY_REPORT_ID}, ${TENANT_ID}, ${VARIANT_ID}, ${CONTENT_VERSION_ID},
        ${QUALITY_RUN_ID}, '1.0.0', 95, 'pass',
        '{"schema_version":"quality-checker-data@1","issues":[]}'::jsonb,
        ${geoScores(database)}
      ),
      (
        ${OTHER_QUALITY_REPORT_ID}, ${TENANT_ID}, ${OTHER_VARIANT_ID},
        ${OTHER_CONTENT_VERSION_ID}, ${OTHER_QUALITY_RUN_ID}, '1.0.0', 94, 'pass',
        '{"schema_version":"quality-checker-data@1","issues":[]}'::jsonb,
        ${geoScores(database)}
      )
  `;
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
      uri, content_hash, status, created_by
    ) VALUES (
      ${SOURCE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Submit Evidence',
      'txt', 'text/plain', 's3://review/submit-evidence.txt', ${'8'.repeat(64)},
      'active', ${USER_ID}
    )
  `;
  await database`
    INSERT INTO source_chunks (
      id, tenant_id, source_document_id, chunk_no, text, text_hash,
      metadata_json, token_count, status
    ) VALUES (
      ${CHUNK_ID}, ${TENANT_ID}, ${SOURCE_ID}, 0, ${QUOTE}, ${sha256(QUOTE)},
      ${database.json({
        char_end: QUOTE.length,
        char_start: 0,
        schema_version: 'chunk-metadata@1',
      })},
      14, 'active'
    )
  `;
  await database`
    INSERT INTO ai_citations (
      id, tenant_id, content_version_id, claim_key, claim_text,
      chunk_id, quote_text, quote_hash
    ) VALUES
      (
        ${CITATION_ID}, ${TENANT_ID}, ${CONTENT_VERSION_ID}, 'freeze-review', ${QUOTE},
        ${CHUNK_ID}, ${QUOTE}, ${sha256(QUOTE)}
      ),
      (
        ${OTHER_CITATION_ID}, ${TENANT_ID}, ${OTHER_CONTENT_VERSION_ID},
        'freeze-review-other', ${QUOTE}, ${CHUNK_ID}, ${QUOTE}, ${sha256(QUOTE)}
      )
  `;
}

function geoScores(database: Sql): ReturnType<Sql['json']> {
  return database.json({
    answerability: 95,
    entity: 95,
    evidence: 95,
    platform_fit: 95,
    question: 95,
    readability_safety: 95,
    schema_version: 'geo-scores@1',
    total: 95,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL test client is not initialized');
  return client;
}
