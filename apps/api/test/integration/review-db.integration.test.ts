import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  ReviewRepository,
  type CreateReviewSnapshotInput,
  type ReviewScope,
} from '../../src/modules/review/repositories/index.js';

const USER_ID = '11000000-0000-4000-8000-000000000117';
const OTHER_USER_ID = '12000000-0000-4000-8000-000000000117';
const TENANT_ID = '21000000-0000-4000-8000-000000000117';
const OTHER_TENANT_ID = '22000000-0000-4000-8000-000000000117';
const WORKSPACE_ID = '31000000-0000-4000-8000-000000000117';
const PROJECT_ID = '41000000-0000-4000-8000-000000000117';
const BRAND_PROFILE_ID = '51000000-0000-4000-8000-000000000117';
const BRIEF_ID = '61000000-0000-4000-8000-000000000117';
const PACKAGE_ID = '71000000-0000-4000-8000-000000000117';
const VARIANT_ID = '81000000-0000-4000-8000-000000000117';
const CONTENT_VERSION_ID = '91000000-0000-4000-8000-000000000117';
const QUALITY_RUN_ID = 'a1000000-0000-4000-8000-000000000117';
const QUALITY_REPORT_ID = 'b1000000-0000-4000-8000-000000000117';
const PROMPT_VERSION_ID = 'c1000000-0000-4000-8000-000000000117';
const PLATFORM_RULE_VERSION_ID = 'd1000000-0000-4000-8000-000000000117';
const SOURCE_ID = 'e1000000-0000-4000-8000-000000000117';
const CHUNK_ID = 'f1000000-0000-4000-8000-000000000117';
const CITATION_ID = 'a2000000-0000-4000-8000-000000000117';
const SNAPSHOT_ID = 'b2000000-0000-4000-8000-000000000117';
const SNAPSHOT_VARIANT_ID = 'c2000000-0000-4000-8000-000000000117';
const REQUIREMENT_ID = 'd2000000-0000-4000-8000-000000000117';
const CONTENT_HASH = '1'.repeat(64);
const SNAPSHOT_HASH = '2'.repeat(64);
const CITATION_HASH = '3'.repeat(64);
const QUOTE = '审核证据必须绑定到精确内容版本。';

const SCOPE: ReviewScope = {
  projectId: PROJECT_ID,
  tenantId: TENANT_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

describe('review database', () => {
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
        fact_check_results, ai_citations, content_block_locks, content_blocks, content_versions,
        content_variants, content_packages, fact_sources, facts, embeddings,
        source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs,
        source_documents, topic_candidates, generation_runs, keywords, keyword_sets,
        brand_profiles, workspace_memberships, projects, workspaces, audit_events,
        outbox_events, support_access_grants, idempotency_records,
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

  it('installs the frozen review and global version tables with scoped indexes', async () => {
    const database = requireClient(client);
    const tables = await database<{ name: string }[]>`
      SELECT tablename AS name
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'prompt_versions', 'platform_rule_versions', 'review_snapshots',
          'review_snapshot_variants', 'review_snapshot_citations',
          'review_requirements', 'review_actions'
        )
      ORDER BY tablename
    `;
    expect(tables.map((table) => table.name)).toEqual([
      'platform_rule_versions',
      'prompt_versions',
      'review_actions',
      'review_requirements',
      'review_snapshot_citations',
      'review_snapshot_variants',
      'review_snapshots',
    ]);
    const indexes = await database<{ name: string }[]>`
      SELECT indexname AS name
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'review_snapshot_variants_snapshot_variant_uq',
          'review_snapshots_tenant_hash_uq'
        )
      ORDER BY indexname
    `;
    expect(indexes.map((index) => index.name)).toEqual([
      'review_snapshot_variants_snapshot_variant_uq',
      'review_snapshots_tenant_hash_uq',
    ]);
  });

  it('persists and returns one complete frozen graph within project scope', async () => {
    const repository = new ReviewRepository(requireClient(client));
    const snapshot = await repository.createSnapshot(SCOPE, snapshotInput());

    expect(snapshot).toMatchObject({
      brandProfileId: BRAND_PROFILE_ID,
      id: SNAPSHOT_ID,
      packageId: PACKAGE_ID,
      snapshotHash: SNAPSHOT_HASH,
      status: 'in_review',
      version: 1,
    });
    expect(snapshot.variants).toMatchObject([
      {
        citations: [{ aiCitationId: CITATION_ID, citationHash: CITATION_HASH }],
        contentHash: CONTENT_HASH,
        contentVersionId: CONTENT_VERSION_ID,
        id: SNAPSHOT_VARIANT_ID,
        platformRuleVersionId: PLATFORM_RULE_VERSION_ID,
        qualityReportId: QUALITY_REPORT_ID,
        variantId: VARIANT_ID,
      },
    ]);
    expect(snapshot.requirements).toMatchObject([
      { id: REQUIREMENT_ID, requiredRole: 'reviewer', status: 'pending' },
    ]);
    await expect(
      repository.findSnapshot(
        { ...SCOPE, tenantId: OTHER_TENANT_ID, userId: OTHER_USER_ID },
        SNAPSHOT_ID,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects cross-tenant and mismatched frozen content relations', async () => {
    const database = requireClient(client);
    await expect(
      database`
        INSERT INTO review_snapshots (
          tenant_id, package_id, snapshot_hash, brand_profile_id, prompt_version_id,
          model_key, platform_rules_hash, quality_rules_hash, created_by
        ) VALUES (
          ${OTHER_TENANT_ID}, ${PACKAGE_ID}, ${'4'.repeat(64)}, ${BRAND_PROFILE_ID},
          ${PROMPT_VERSION_ID}, 'deepseek-pro', ${'5'.repeat(64)}, ${'6'.repeat(64)},
          ${OTHER_USER_ID}
        )
      `,
    ).rejects.toThrow(/outside the package scope/u);

    const repository = new ReviewRepository(database);
    await expect(
      repository.createSnapshot(
        { ...SCOPE, projectId: BRIEF_ID },
        { ...snapshotInput(), snapshotHash: '6'.repeat(64) },
      ),
    ).rejects.toThrow(/outside the caller project scope/u);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM review_snapshots
      `,
    ).toEqual([{ count: 0 }]);
    await expect(
      repository.createSnapshot(SCOPE, {
        ...snapshotInput(),
        snapshotHash: '7'.repeat(64),
        variants: [{ ...snapshotInput().variants[0]!, contentHash: '8'.repeat(64) }],
      }),
    ).rejects.toThrow(/outside the frozen content scope/u);
  });

  it('protects frozen fields and append-only citation and action histories', async () => {
    const database = requireClient(client);
    await new ReviewRepository(database).createSnapshot(SCOPE, snapshotInput());
    await expect(
      database`
        UPDATE review_snapshots
        SET model_key = 'different-model'
        WHERE id = ${SNAPSHOT_ID}
      `,
    ).rejects.toThrow(/frozen fields are immutable/u);
    await expect(database`DELETE FROM review_snapshots WHERE id = ${SNAPSHOT_ID}`).rejects.toThrow(
      /cannot be deleted/u,
    );
    await expect(
      database`
        UPDATE prompt_versions
        SET task_template = 'Changed prompt'
        WHERE id = ${PROMPT_VERSION_ID}
      `,
    ).rejects.toThrow(/content is immutable/u);
    await expect(
      database`DELETE FROM platform_rule_versions WHERE id = ${PLATFORM_RULE_VERSION_ID}`,
    ).rejects.toThrow(/cannot be deleted/u);
    await expect(
      database`
        UPDATE review_snapshot_citations
        SET citation_hash = ${'9'.repeat(64)}
        WHERE snapshot_variant_id = ${SNAPSHOT_VARIANT_ID}
      `,
    ).rejects.toThrow(/append-only/u);
    await database`
      INSERT INTO review_actions (
        tenant_id, snapshot_id, reviewer_id, action, variant_ids, comment
      ) VALUES (
        ${TENANT_ID}, ${SNAPSHOT_ID}, ${USER_ID}, 'comment',
        ARRAY[${VARIANT_ID}::uuid], '已核对冻结证据'
      )
    `;
    await expect(
      database`DELETE FROM review_actions WHERE snapshot_id = ${SNAPSHOT_ID}`,
    ).rejects.toThrow(/append-only/u);
  });

  it('enforces signoff targets, reject comments, and snapshot variant subsets', async () => {
    const database = requireClient(client);
    await new ReviewRepository(database).createSnapshot(SCOPE, snapshotInput());
    await expect(
      database`
        INSERT INTO review_requirements (
          tenant_id, snapshot_id, required_role, required_user_id, requested_by
        ) VALUES (
          ${TENANT_ID}, ${SNAPSHOT_ID}, 'reviewer', ${USER_ID}, ${USER_ID}
        )
      `,
    ).rejects.toThrow(/review_requirements_target_check/u);
    await expect(
      database`
        INSERT INTO review_actions (
          tenant_id, snapshot_id, reviewer_id, action, variant_ids
        ) VALUES (
          ${TENANT_ID}, ${SNAPSHOT_ID}, ${USER_ID}, 'reject', ARRAY[${VARIANT_ID}::uuid]
        )
      `,
    ).rejects.toThrow(/review_actions_reject_comment_check/u);
    await expect(
      database`
        INSERT INTO review_actions (
          tenant_id, snapshot_id, reviewer_id, action, variant_ids, comment
        ) VALUES (
          ${TENANT_ID}, ${SNAPSHOT_ID}, ${USER_ID}, 'approve',
          ARRAY[${BRIEF_ID}::uuid], 'wrong scope'
        )
      `,
    ).rejects.toThrow(/subset of the snapshot/u);
  });
});

function snapshotInput(): CreateReviewSnapshotInput {
  return {
    brandProfileId: BRAND_PROFILE_ID,
    id: SNAPSHOT_ID,
    modelKey: 'deepseek-pro',
    packageId: PACKAGE_ID,
    platformRulesHash: 'a'.repeat(64),
    promptVersionId: PROMPT_VERSION_ID,
    qualityRulesHash: 'b'.repeat(64),
    requirements: [{ id: REQUIREMENT_ID, requiredRole: 'reviewer' }],
    snapshotHash: SNAPSHOT_HASH,
    variants: [
      {
        citations: [{ aiCitationId: CITATION_ID, citationHash: CITATION_HASH }],
        contentHash: CONTENT_HASH,
        contentVersionId: CONTENT_VERSION_ID,
        id: SNAPSHOT_VARIANT_ID,
        platformRuleVersionId: PLATFORM_RULE_VERSION_ID,
        qualityReportId: QUALITY_REPORT_ID,
        variantId: VARIANT_ID,
      },
    ],
  };
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status) VALUES
      (${USER_ID}, 'reviewer@example.com', 'Review Owner', 'active'),
      (${OTHER_USER_ID}, 'other-reviewer@example.com', 'Other Owner', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status) VALUES
      (${TENANT_ID}, 'Review Tenant', 'review-tenant', 'active'),
      (${OTHER_TENANT_ID}, 'Other Review Tenant', 'other-review-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status) VALUES
      (${TENANT_ID}, ${USER_ID}, 'tenant_owner', 'active'),
      (${OTHER_TENANT_ID}, ${OTHER_USER_ID}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES (${WORKSPACE_ID}, ${TENANT_ID}, 'Review Workspace', 'review-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES (${PROJECT_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 'Review Project', ${USER_ID})
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
      ${BRIEF_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Review Brief',
      'trust', 'Enterprise reviewers', ARRAY['zhihu']::varchar[],
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
    INSERT INTO content_variants (id, tenant_id, package_id, platform_code, status)
    VALUES (${VARIANT_ID}, ${TENANT_ID}, ${PACKAGE_ID}, 'zhihu', 'quality_passed')
  `;
  await database`
    INSERT INTO content_versions (
      id, tenant_id, package_id, variant_id, version_no, schema_version,
      content_json, content_hash, created_by
    ) VALUES (
      ${CONTENT_VERSION_ID}, ${TENANT_ID}, ${PACKAGE_ID}, ${VARIANT_ID}, 1,
      'content-zhihu@1',
      '{"schema_version":"content-zhihu@1","title":"Frozen review content"}'::jsonb,
      ${CONTENT_HASH}, ${USER_ID}
    )
  `;
  await database`
    UPDATE content_variants SET current_content_version_id = ${CONTENT_VERSION_ID}
    WHERE id = ${VARIANT_ID}
  `;
  await database`
    INSERT INTO prompt_versions (
      id, skill_name, version, schema_version, system_prompt, task_template,
      content_hash, status, created_by, published_at
    ) VALUES (
      ${PROMPT_VERSION_ID}, 'content-writer', '1.0.0', 'skill-result@1',
      'Write only evidence-backed content.', 'Create {{platform}} content.',
      ${'c'.repeat(64)}, 'published', ${USER_ID}, now()
    )
  `;
  await database`
    INSERT INTO platform_rule_versions (
      id, platform_code, version, rules_json, content_hash, status, created_by, published_at
    ) VALUES (
      ${PLATFORM_RULE_VERSION_ID}, 'zhihu', '1.0.0',
      '{"schema_version":"platform-rules@1","title_max":100}'::jsonb,
      ${'d'.repeat(64)}, 'published', ${USER_ID}, now()
    )
  `;
  await database`
    INSERT INTO generation_runs (
      id, tenant_id, workspace_id, project_id, package_id, variant_id,
      skill_name, skill_version, prompt_version_id, model_key, status,
      input_hash, request_id, started_at, finished_at
    ) VALUES (
      ${QUALITY_RUN_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${PACKAGE_ID},
      ${VARIANT_ID}, 'quality-checker', '1.0.0', ${PROMPT_VERSION_ID},
      'deepseek-pro', 'succeeded', ${'e'.repeat(64)}, 'review-quality-run', now(), now()
    )
  `;
  await database`
    INSERT INTO quality_reports (
      id, tenant_id, variant_id, content_version_id, generation_run_id,
      checker_version, score, decision, issues_json, geo_scores_json
    ) VALUES (
      ${QUALITY_REPORT_ID}, ${TENANT_ID}, ${VARIANT_ID}, ${CONTENT_VERSION_ID},
      ${QUALITY_RUN_ID}, '1.0.0', 95, 'pass',
      '{"schema_version":"quality-checker-data@1","issues":[]}'::jsonb,
      '{"schema_version":"geo-scores@1","entity":95,"question":95,"answerability":95,"evidence":95,"platform_fit":95,"readability_safety":95,"total":95}'::jsonb
    )
  `;
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
      uri, content_hash, status, created_by
    ) VALUES (
      ${SOURCE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Review Evidence',
      'txt', 'text/plain', 's3://review/evidence.txt', ${'f'.repeat(64)}, 'active', ${USER_ID}
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
      12, 'active'
    )
  `;
  await database`
    INSERT INTO ai_citations (
      id, tenant_id, content_version_id, claim_key, claim_text,
      chunk_id, quote_text, quote_hash
    ) VALUES (
      ${CITATION_ID}, ${TENANT_ID}, ${CONTENT_VERSION_ID}, 'review-freeze', ${QUOTE},
      ${CHUNK_ID}, ${QUOTE}, ${sha256(QUOTE)}
    )
  `;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL test client is not initialized');
  return client;
}
