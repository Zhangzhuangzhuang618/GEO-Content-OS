import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  ReviewDecisionService,
  type ReviewDecisionScope,
} from '../../src/modules/review/decisions/index.js';
import { SubmitReviewService } from '../../src/modules/review/submit/index.js';

const EDITOR_ID = '11000000-0000-4000-8000-000000000119';
const REVIEWER_ID = '12000000-0000-4000-8000-000000000119';
const SIGNER_ID = '13000000-0000-4000-8000-000000000119';
const VIEWER_ID = '14000000-0000-4000-8000-000000000119';
const TENANT_ID = '21000000-0000-4000-8000-000000000119';
const WORKSPACE_ID = '31000000-0000-4000-8000-000000000119';
const PROJECT_ID = '41000000-0000-4000-8000-000000000119';
const BRAND_ID = '51000000-0000-4000-8000-000000000119';
const BRIEF_ID = '61000000-0000-4000-8000-000000000119';
const PACKAGE_ID = '71000000-0000-4000-8000-000000000119';
const VARIANT_ID = '81000000-0000-4000-8000-000000000119';
const SECOND_VARIANT_ID = '82000000-0000-4000-8000-000000000119';
const VERSION_ID = '91000000-0000-4000-8000-000000000119';
const SECOND_VERSION_ID = '92000000-0000-4000-8000-000000000119';
const RUN_ID = 'a1000000-0000-4000-8000-000000000119';
const SECOND_RUN_ID = 'a2000000-0000-4000-8000-000000000119';
const REPORT_ID = 'b1000000-0000-4000-8000-000000000119';
const SECOND_REPORT_ID = 'b2000000-0000-4000-8000-000000000119';
const PROMPT_ID = 'c1000000-0000-4000-8000-000000000119';
const RULE_ID = 'd1000000-0000-4000-8000-000000000119';
const SECOND_RULE_ID = 'd2000000-0000-4000-8000-000000000119';
const SOURCE_ID = 'e1000000-0000-4000-8000-000000000119';
const CHUNK_ID = 'f1000000-0000-4000-8000-000000000119';
const CITATION_ID = 'a3000000-0000-4000-8000-000000000119';
const EXTRA_CITATION_ID = 'a4000000-0000-4000-8000-000000000119';
const CONTENT_HASH = '1'.repeat(64);
const SECOND_CONTENT_HASH = '2'.repeat(64);
const QUOTE = '审核决定必须基于未漂移的冻结快照。';

const EDITOR_SCOPE = {
  projectId: PROJECT_ID,
  requestId: 'req-review-submit-119',
  tenantId: TENANT_ID,
  userId: EDITOR_ID,
  workspaceId: WORKSPACE_ID,
};

const REVIEW_SCOPE: ReviewDecisionScope = {
  ...EDITOR_SCOPE,
  requestId: 'req-review-decision-119',
  userId: REVIEWER_ID,
};

describe('review decisions', () => {
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

  it('approves selected variants independently and projects terminal package state', async () => {
    const database = requireClient(client);
    const snapshot = await submit(database);
    const service = new ReviewDecisionService(database);

    const partial = await service.approve(REVIEW_SCOPE, snapshot.id, {
      expectedVersion: 1,
      variantIds: [VARIANT_ID],
    });
    expect(partial.snapshot).toMatchObject({ status: 'in_review', version: 2 });
    expect(statuses(partial.snapshot)).toEqual([
      [VARIANT_ID, 'approved'],
      [SECOND_VARIANT_ID, 'in_review'],
    ]);
    expect(await contentState(database)).toEqual([
      [VARIANT_ID, 'approved'],
      [SECOND_VARIANT_ID, 'in_review'],
    ]);

    const completed = await service.approve(
      { ...REVIEW_SCOPE, requestId: 'req-review-decision-119-2' },
      snapshot.id,
      { expectedVersion: 2, variantIds: [SECOND_VARIANT_ID] },
    );
    expect(completed.snapshot).toMatchObject({ status: 'approved', version: 3 });
    expect(await packageStatus(database)).toBe('approved');
    expect(completed.snapshot.actions.map((action) => action.action)).toEqual([
      'approve',
      'approve',
    ]);
  });

  it('keeps preliminary approval blocked until the required user signs off', async () => {
    const database = requireClient(client);
    const snapshot = await submit(database, [VARIANT_ID]);
    const service = new ReviewDecisionService(database);

    const requested = await service.requestSignoff(REVIEW_SCOPE, snapshot.id, {
      expectedVersion: 1,
      requiredUserId: SIGNER_ID,
      variantIds: [VARIANT_ID],
    });
    expect(requested.snapshot.requirements).toMatchObject([
      { requiredUserId: SIGNER_ID, status: 'pending', variantId: VARIANT_ID },
    ]);

    const preliminary = await service.approve(REVIEW_SCOPE, snapshot.id, {
      expectedVersion: 2,
      variantIds: [VARIANT_ID],
    });
    expect(preliminary.snapshot).toMatchObject({ status: 'in_review', version: 3 });
    expect(await variantStatus(database, VARIANT_ID)).toBe('review_approved');
    expect(preliminary.snapshot.requirements[0]?.status).toBe('pending');

    const signed = await service.approve(
      { ...REVIEW_SCOPE, requestId: 'req-required-signoff', userId: SIGNER_ID },
      snapshot.id,
      { expectedVersion: 3, variantIds: [VARIANT_ID] },
    );
    expect(signed.snapshot).toMatchObject({ status: 'approved', version: 4 });
    expect(signed.snapshot.requirements[0]).toMatchObject({
      completedAt: expect.any(Date),
      status: 'approved',
    });
    expect(await variantStatus(database, VARIANT_ID)).toBe('approved');
  });

  it('requires a second reviewer to satisfy role-based signoff', async () => {
    const database = requireClient(client);
    const snapshot = await submit(database, [VARIANT_ID]);
    const service = new ReviewDecisionService(database);

    await service.requestSignoff(REVIEW_SCOPE, snapshot.id, {
      expectedVersion: 1,
      requiredRole: 'reviewer',
      variantIds: [VARIANT_ID],
    });
    const requesterApproval = await service.approve(REVIEW_SCOPE, snapshot.id, {
      expectedVersion: 2,
      variantIds: [VARIANT_ID],
    });
    expect(requesterApproval.snapshot.requirements[0]?.status).toBe('pending');

    const secondReviewer = await service.approve(
      { ...REVIEW_SCOPE, requestId: 'req-role-signoff', userId: SIGNER_ID },
      snapshot.id,
      { expectedVersion: 3, variantIds: [VARIANT_ID] },
    );
    expect(secondReviewer.snapshot).toMatchObject({ status: 'approved', version: 4 });
    expect(secondReviewer.snapshot.requirements[0]?.status).toBe('approved');
  });

  it('rejects only the selected subset and requires a nonblank comment', async () => {
    const database = requireClient(client);
    const snapshot = await submit(database);
    const service = new ReviewDecisionService(database);

    await expect(
      service.reject(REVIEW_SCOPE, snapshot.id, {
        comment: '   ',
        expectedVersion: 1,
        variantIds: [VARIANT_ID],
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_DECISION_INPUT_INVALID' });

    const rejected = await service.reject(REVIEW_SCOPE, snapshot.id, {
      comment: '引用不足，需要补充来源。',
      expectedVersion: 1,
      variantIds: [VARIANT_ID],
    });
    expect(rejected.snapshot).toMatchObject({ status: 'in_review', version: 2 });
    expect(statuses(rejected.snapshot)).toEqual([
      [VARIANT_ID, 'rejected'],
      [SECOND_VARIANT_ID, 'in_review'],
    ]);
    expect(await variantStatus(database, VARIANT_ID)).toBe('review_rejected');
    expect(await variantStatus(database, SECOND_VARIANT_ID)).toBe('in_review');
  });

  it('rejects decisions when the frozen citation set has drifted', async () => {
    const database = requireClient(client);
    const snapshot = await submit(database, [VARIANT_ID]);
    await database`
      INSERT INTO ai_citations (
        id, tenant_id, content_version_id, claim_key, claim_text,
        chunk_id, quote_text, quote_hash
      ) VALUES (
        ${EXTRA_CITATION_ID}, ${TENANT_ID}, ${VERSION_ID}, 'late-citation', ${QUOTE},
        ${CHUNK_ID}, ${QUOTE}, ${sha256(QUOTE)}
      )
    `;

    await expect(
      new ReviewDecisionService(database).approve(REVIEW_SCOPE, snapshot.id, {
        expectedVersion: 1,
        variantIds: [VARIANT_ID],
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_DECISION_VERSION_CONFLICT' });
    expect(await variantStatus(database, VARIANT_ID)).toBe('in_review');
    expect(
      await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM review_actions`,
    ).toEqual([{ count: 0 }]);
  });

  it('enforces optimistic locking and reviewer permission without leaking foreign scope', async () => {
    const database = requireClient(client);
    const snapshot = await submit(database, [VARIANT_ID]);
    const service = new ReviewDecisionService(database);

    await expect(
      service.approve(REVIEW_SCOPE, snapshot.id, {
        expectedVersion: 9,
        variantIds: [VARIANT_ID],
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_DECISION_VERSION_CONFLICT' });
    await expect(
      service.requestSignoff(REVIEW_SCOPE, snapshot.id, {
        expectedVersion: 1,
        requiredUserId: REVIEWER_ID,
        variantIds: [VARIANT_ID],
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_DECISION_INPUT_INVALID' });
    await expect(
      service.approve({ ...REVIEW_SCOPE, userId: VIEWER_ID }, snapshot.id, {
        expectedVersion: 1,
        variantIds: [VARIANT_ID],
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_DECISION_PERMISSION_DENIED' });
    await expect(
      service.approve(
        { ...REVIEW_SCOPE, projectId: '42000000-0000-4000-8000-000000000119' },
        snapshot.id,
        { expectedVersion: 1, variantIds: [VARIANT_ID] },
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_DECISION_NOT_FOUND' });
  });
});

async function submit(database: Sql, variantIds = [VARIANT_ID, SECOND_VARIANT_ID]) {
  return (
    await new SubmitReviewService(database).submit(EDITOR_SCOPE, {
      packageId: PACKAGE_ID,
      variantIds,
    })
  ).snapshot;
}

function statuses(snapshot: {
  readonly variants: readonly { readonly status: string; readonly variantId: string }[];
}): readonly (readonly [string, string])[] {
  return snapshot.variants.map((variant) => [variant.variantId, variant.status] as const).sort();
}

async function contentState(database: Sql): Promise<readonly (readonly [string, string])[]> {
  const rows = await database<{ id: string; status: string }[]>`
    SELECT id, status FROM content_variants WHERE package_id = ${PACKAGE_ID} ORDER BY id
  `;
  return rows.map((row) => [row.id, row.status] as const);
}

async function variantStatus(database: Sql, variantId: string): Promise<string | undefined> {
  const rows = await database<{ status: string }[]>`
    SELECT status FROM content_variants WHERE id = ${variantId}
  `;
  return rows[0]?.status;
}

async function packageStatus(database: Sql): Promise<string | undefined> {
  const rows = await database<{ status: string }[]>`
    SELECT status FROM content_packages WHERE id = ${PACKAGE_ID}
  `;
  return rows[0]?.status;
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status) VALUES
      (${EDITOR_ID}, 'decision-editor@example.com', 'Decision Editor', 'active'),
      (${REVIEWER_ID}, 'decision-reviewer@example.com', 'Decision Reviewer', 'active'),
      (${SIGNER_ID}, 'decision-signer@example.com', 'Decision Signer', 'active'),
      (${VIEWER_ID}, 'decision-viewer@example.com', 'Decision Viewer', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${TENANT_ID}, 'Decision Tenant', 'decision-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status) VALUES
      (${TENANT_ID}, ${EDITOR_ID}, 'content_editor', 'active'),
      (${TENANT_ID}, ${REVIEWER_ID}, 'reviewer', 'active'),
      (${TENANT_ID}, ${SIGNER_ID}, 'reviewer', 'active'),
      (${TENANT_ID}, ${VIEWER_ID}, 'viewer', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES (${WORKSPACE_ID}, ${TENANT_ID}, 'Decision Workspace', 'decision-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES (${PROJECT_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 'Decision Project', ${EDITOR_ID})
  `;
  await database`
    INSERT INTO workspace_memberships (workspace_id, user_id) VALUES
      (${WORKSPACE_ID}, ${REVIEWER_ID}),
      (${WORKSPACE_ID}, ${SIGNER_ID}),
      (${WORKSPACE_ID}, ${VIEWER_ID})
  `;
  await database`
    INSERT INTO brand_profiles (
      id, tenant_id, workspace_id, version, status, schema_version,
      profile_json, created_by, published_at
    ) VALUES (
      ${BRAND_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 1, 'published', 'brand-profile@1',
      ${database.json({
        audience: ['Reviewers'],
        banned: ['Unsupported claims'],
        compliance: ['Citations required'],
        cta: 'Review evidence',
        differentiators: ['Frozen decisions'],
        positioning: 'Evidence-led content',
        tone: 'Direct',
      })},
      ${EDITOR_ID}, now()
    )
  `;
  await database`
    INSERT INTO briefs (
      id, tenant_id, workspace_id, project_id, title, objective, audience,
      platform_codes, constraints_json, created_by
    ) VALUES (
      ${BRIEF_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Decision Brief',
      'trust', 'Enterprise reviewers', ARRAY['zhihu','wechat_mp']::varchar[],
      '{"schema_version":"brief-constraints@1"}'::jsonb, ${EDITOR_ID}
    )
  `;
  await database`
    INSERT INTO content_packages (
      id, tenant_id, workspace_id, project_id, brief_id, status, created_by
    ) VALUES (
      ${PACKAGE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${BRIEF_ID},
      'generated', ${EDITOR_ID}
    )
  `;
  await database`
    INSERT INTO content_variants (id, tenant_id, package_id, platform_code, status) VALUES
      (${VARIANT_ID}, ${TENANT_ID}, ${PACKAGE_ID}, 'zhihu', 'quality_passed'),
      (${SECOND_VARIANT_ID}, ${TENANT_ID}, ${PACKAGE_ID}, 'wechat_mp', 'quality_passed')
  `;
  await database`
    INSERT INTO content_versions (
      id, tenant_id, package_id, variant_id, version_no, schema_version,
      content_json, content_hash, created_by
    ) VALUES
      (${VERSION_ID}, ${TENANT_ID}, ${PACKAGE_ID}, ${VARIANT_ID}, 1,
        'content-zhihu@1', '{"schema_version":"content-zhihu@1","title":"Zhihu"}'::jsonb,
        ${CONTENT_HASH}, ${EDITOR_ID}),
      (${SECOND_VERSION_ID}, ${TENANT_ID}, ${PACKAGE_ID}, ${SECOND_VARIANT_ID}, 1,
        'content-wechat_mp@1',
        '{"schema_version":"content-wechat_mp@1","title":"Wechat"}'::jsonb,
        ${SECOND_CONTENT_HASH}, ${EDITOR_ID})
  `;
  await database`
    UPDATE content_variants SET current_content_version_id = CASE id
      WHEN ${VARIANT_ID}::uuid THEN ${VERSION_ID}::uuid ELSE ${SECOND_VERSION_ID}::uuid END
    WHERE package_id = ${PACKAGE_ID}
  `;
  await database`
    INSERT INTO prompt_versions (
      id, skill_name, version, schema_version, system_prompt, task_template,
      content_hash, status, created_by, published_at
    ) VALUES (
      ${PROMPT_ID}, 'quality-checker', '1.0.0', 'quality-checker-data@1',
      'Check frozen content.', 'Review {{content_version_id}}.',
      ${'3'.repeat(64)}, 'published', ${EDITOR_ID}, now()
    )
  `;
  await database`
    INSERT INTO platform_rule_versions (
      id, platform_code, version, rules_json, content_hash, status, created_by, published_at
    ) VALUES
      (${RULE_ID}, 'zhihu', '1.0.0',
        '{"schema_version":"platform-rules@1","title_max":100}'::jsonb,
        ${'4'.repeat(64)}, 'published', ${EDITOR_ID}, now()),
      (${SECOND_RULE_ID}, 'wechat_mp', '1.0.0',
        '{"schema_version":"platform-rules@1","title_max":64}'::jsonb,
        ${'5'.repeat(64)}, 'published', ${EDITOR_ID}, now())
  `;
  await database`
    INSERT INTO generation_runs (
      id, tenant_id, workspace_id, project_id, package_id, variant_id,
      skill_name, skill_version, prompt_version_id, model_key, status,
      input_hash, request_id, started_at, finished_at
    ) VALUES
      (${RUN_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${PACKAGE_ID}, ${VARIANT_ID},
        'quality-checker', '1.0.0', ${PROMPT_ID}, 'deepseek-pro', 'succeeded',
        ${'6'.repeat(64)}, 'decision-run-1', now(), now()),
      (${SECOND_RUN_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${PACKAGE_ID},
        ${SECOND_VARIANT_ID}, 'quality-checker', '1.0.0', ${PROMPT_ID}, 'deepseek-pro',
        'succeeded', ${'7'.repeat(64)}, 'decision-run-2', now(), now())
  `;
  await database`
    INSERT INTO quality_reports (
      id, tenant_id, variant_id, content_version_id, generation_run_id,
      checker_version, score, decision, issues_json, geo_scores_json
    ) VALUES
      (${REPORT_ID}, ${TENANT_ID}, ${VARIANT_ID}, ${VERSION_ID}, ${RUN_ID}, '1.0.0', 95,
        'pass', '{"schema_version":"quality-checker-data@1","issues":[]}'::jsonb,
        ${geoScores(database)}),
      (${SECOND_REPORT_ID}, ${TENANT_ID}, ${SECOND_VARIANT_ID}, ${SECOND_VERSION_ID},
        ${SECOND_RUN_ID}, '1.0.0', 94, 'pass',
        '{"schema_version":"quality-checker-data@1","issues":[]}'::jsonb,
        ${geoScores(database)})
  `;
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
      uri, content_hash, status, created_by
    ) VALUES (
      ${SOURCE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Decision Evidence',
      'txt', 'text/plain', 's3://review/decision.txt', ${'8'.repeat(64)}, 'active', ${EDITOR_ID}
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
      })}, 12, 'active'
    )
  `;
  await database`
    INSERT INTO ai_citations (
      id, tenant_id, content_version_id, claim_key, claim_text,
      chunk_id, quote_text, quote_hash
    ) VALUES (
      ${CITATION_ID}, ${TENANT_ID}, ${VERSION_ID}, 'decision-guard', ${QUOTE},
      ${CHUNK_ID}, ${QUOTE}, ${sha256(QUOTE)}
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
