import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  ContentPackageRepository,
  ContentPackageStateError,
  ContentVariantRepository,
  ContentVariantStateError,
  type ContentPackageAggregate,
  type ContentScope,
} from '../../src/modules/content/index.js';

const CONTENT_ID = '14000000-0000-4000-8000-000000000045';
const STRATEGY_ID = '14000000-0000-4000-8000-000000000145';
const SCOPED_CONTENT_ID = '14000000-0000-4000-8000-000000000245';
const OTHER_OWNER_ID = '14000000-0000-4000-8000-000000000345';
const TENANT_ID = '24000000-0000-4000-8000-000000000045';
const OTHER_TENANT_ID = '24000000-0000-4000-8000-000000000145';
const WORKSPACE_A = '34000000-0000-4000-8000-000000000045';
const WORKSPACE_B = '34000000-0000-4000-8000-000000000145';
const OTHER_WORKSPACE = '34000000-0000-4000-8000-000000000245';
const PROJECT_A = '44000000-0000-4000-8000-000000000045';
const PROJECT_B = '44000000-0000-4000-8000-000000000145';
const OTHER_PROJECT = '44000000-0000-4000-8000-000000000245';
const BRIEF_A = '54000000-0000-4000-8000-000000000045';
const BRIEF_TWO = '54000000-0000-4000-8000-000000000145';
const BRIEF_B = '54000000-0000-4000-8000-000000000245';

const SCOPE_A: ContentScope = {
  projectId: PROJECT_A,
  tenantId: TENANT_ID,
  userId: CONTENT_ID,
  workspaceId: WORKSPACE_A,
};

describe('Content Package and Variant repositories', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 8 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE ai_citations, content_block_locks, content_blocks, content_versions, content_variants, content_packages, fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('creates one required draft Variant per selected Brief platform and returns scoped aggregates', async () => {
    const database = requireClient(client);
    const packages = new ContentPackageRepository(database);
    const variants = new ContentVariantRepository(database);
    const aggregate = await createPackage(database, packages, SCOPE_A, BRIEF_A, 'package-create-1');
    expect(aggregate.package).toMatchObject({
      briefId: BRIEF_A,
      projectId: PROJECT_A,
      status: 'draft',
      tenantId: TENANT_ID,
      version: 1,
      workspaceId: WORKSPACE_A,
    });
    expect(aggregate.variants.map((variant) => variant.platformCode).sort()).toEqual([
      'official_site',
      'wechat_mp',
      'zhihu',
    ]);
    expect(
      aggregate.variants.every((variant) => variant.isRequired && variant.status === 'draft'),
    ).toBe(true);
    expect(await packages.find(SCOPE_A, aggregate.package.id)).toEqual(aggregate);
    expect(await variants.find(SCOPE_A, aggregate.variants[0]!.id)).toEqual(aggregate.variants[0]);
    expect(
      await packages.find(
        { ...SCOPE_A, tenantId: OTHER_TENANT_ID, userId: OTHER_OWNER_ID },
        aggregate.package.id,
      ),
    ).toBeUndefined();
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM audit_events WHERE action = 'content_package.created'
      `,
    ).toEqual([{ count: 1 }]);
  });

  it('rejects forged scope and non-content producers without leaking Brief existence', async () => {
    const database = requireClient(client);
    const packages = new ContentPackageRepository(database);
    await expect(
      database.begin((transaction) =>
        packages.createFromBrief(
          transaction,
          { ...SCOPE_A, projectId: PROJECT_B, workspaceId: WORKSPACE_B },
          BRIEF_A,
          { requestId: 'forged-package' },
        ),
      ),
    ).rejects.toThrow();
    await expect(
      database.begin((transaction) =>
        packages.createFromBrief(transaction, { ...SCOPE_A, userId: STRATEGY_ID }, BRIEF_A, {
          requestId: 'strategy-package',
        }),
      ),
    ).rejects.toThrow();
    await expect(
      database.begin((transaction) =>
        packages.createFromBrief(transaction, { ...SCOPE_A, userId: SCOPED_CONTENT_ID }, BRIEF_A, {
          requestId: 'scoped-package',
        }),
      ),
    ).rejects.toThrow();
    expect(
      await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM content_packages`,
    ).toEqual([{ count: 0 }]);
  });

  it('drops a Variant atomically, records the reason, and always preserves one required Variant', async () => {
    const database = requireClient(client);
    const packages = new ContentPackageRepository(database);
    const variants = new ContentVariantRepository(database);
    const aggregate = await createPackage(database, packages, SCOPE_A, BRIEF_A, 'package-create-2');
    const targets = [...aggregate.variants].sort((left, right) => left.id.localeCompare(right.id));
    const first = targets[0]!;
    const dropped = await database.begin((transaction) =>
      variants.drop(
        transaction,
        SCOPE_A,
        aggregate.package.id,
        first.id,
        first.version,
        'Platform is outside this campaign scope',
        { requestId: 'variant-drop-1' },
      ),
    );
    expect(dropped).toMatchObject({ isRequired: false, status: 'cancelled', version: 2 });
    await expect(
      database.begin((transaction) =>
        variants.drop(
          transaction,
          SCOPE_A,
          aggregate.package.id,
          first.id,
          first.version,
          'stale replay',
          { requestId: 'variant-drop-stale' },
        ),
      ),
    ).rejects.toThrow();

    const second = targets[1]!;
    await expect(
      database.begin((transaction) =>
        variants.drop(
          transaction,
          SCOPE_A,
          aggregate.package.id,
          second.id,
          second.version,
          '   ',
          { requestId: 'variant-drop-empty-reason' },
        ),
      ),
    ).rejects.toBeInstanceOf(ContentVariantStateError);
    await database.begin((transaction) =>
      variants.drop(
        transaction,
        SCOPE_A,
        aggregate.package.id,
        second.id,
        second.version,
        'Second platform is optional',
        { requestId: 'variant-drop-2' },
      ),
    );
    const last = targets[2]!;
    await expect(
      database.begin((transaction) =>
        variants.drop(
          transaction,
          SCOPE_A,
          aggregate.package.id,
          last.id,
          last.version,
          'Cannot remove final platform',
          { requestId: 'variant-drop-last' },
        ),
      ),
    ).rejects.toBeInstanceOf(ContentVariantStateError);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM content_variants
        WHERE package_id = ${aggregate.package.id}::uuid AND is_required
      `,
    ).toEqual([{ count: 1 }]);
    const audits = await database<{ reason: string }[]>`
      SELECT after_json->>'reason' AS reason
      FROM audit_events
      WHERE action = 'content_variant.dropped'
      ORDER BY created_at
    `;
    expect(audits).toEqual([
      { reason: 'Platform is outside this campaign scope' },
      { reason: 'Second platform is optional' },
    ]);
  });

  it('serializes concurrent drops so two required Variants cannot both become optional', async () => {
    const database = requireClient(client);
    const packages = new ContentPackageRepository(database);
    const variants = new ContentVariantRepository(database);
    const aggregate = await createPackage(
      database,
      packages,
      SCOPE_A,
      BRIEF_TWO,
      'package-create-concurrent',
    );
    const [first, second] = aggregate.variants;
    if (!first || !second) throw new Error('Concurrent test requires two variants');
    const results = await Promise.allSettled([
      database.begin((transaction) =>
        variants.drop(
          transaction,
          SCOPE_A,
          aggregate.package.id,
          first.id,
          first.version,
          'Concurrent drop A',
          { requestId: 'concurrent-drop-a' },
        ),
      ),
      database.begin((transaction) =>
        variants.drop(
          transaction,
          SCOPE_A,
          aggregate.package.id,
          second.id,
          second.version,
          'Concurrent drop B',
          { requestId: 'concurrent-drop-b' },
        ),
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM content_variants
        WHERE package_id = ${aggregate.package.id}::uuid AND is_required
      `,
    ).toEqual([{ count: 1 }]);
  });

  it('blocks drops and abandonment during active runs, then abandons safe packages without clearing required flags', async () => {
    const database = requireClient(client);
    const packages = new ContentPackageRepository(database);
    const variants = new ContentVariantRepository(database);
    const active = await createPackage(
      database,
      packages,
      SCOPE_A,
      BRIEF_TWO,
      'package-create-active',
    );
    await insertRun(database, active, 'queued', 'active-package-run');
    await expect(
      database.begin((transaction) =>
        variants.drop(
          transaction,
          SCOPE_A,
          active.package.id,
          active.variants[0]!.id,
          1,
          'Cannot drop active run',
          { requestId: 'active-drop' },
        ),
      ),
    ).rejects.toBeInstanceOf(ContentVariantStateError);
    await expect(
      database.begin((transaction) =>
        packages.abandon(transaction, SCOPE_A, active.package.id, 1, 'Cannot abandon active run', {
          requestId: 'active-abandon',
        }),
      ),
    ).rejects.toBeInstanceOf(ContentPackageStateError);

    await database`
      UPDATE generation_runs
      SET status = 'cancelled', started_at = now(), finished_at = now()
      WHERE package_id = ${active.package.id}::uuid
    `;
    const abandoned = await database.begin((transaction) =>
      packages.abandon(
        transaction,
        SCOPE_A,
        active.package.id,
        1,
        'Campaign was explicitly abandoned',
        { requestId: 'safe-abandon' },
      ),
    );
    expect(abandoned.package).toMatchObject({ status: 'cancelled', version: 2 });
    expect(abandoned.variants.every((variant) => variant.status === 'cancelled')).toBe(true);
    expect(abandoned.variants.every((variant) => variant.isRequired)).toBe(true);
    expect(
      await database<{ reason: string }[]>`
        SELECT after_json->>'reason' AS reason
        FROM audit_events WHERE action = 'content_package.abandoned'
      `,
    ).toEqual([{ reason: 'Campaign was explicitly abandoned' }]);

    const generated = await createPackage(
      database,
      packages,
      SCOPE_A,
      BRIEF_TWO,
      'package-create-generated',
    );
    await database`
      UPDATE content_packages SET status = 'generated'
      WHERE id = ${generated.package.id}::uuid
    `;
    await expect(
      database.begin((transaction) =>
        packages.abandon(
          transaction,
          SCOPE_A,
          generated.package.id,
          1,
          'Generated package must not be abandoned',
          { requestId: 'generated-abandon' },
        ),
      ),
    ).rejects.toBeInstanceOf(ContentPackageStateError);

    const failed = await createPackage(
      database,
      packages,
      SCOPE_A,
      BRIEF_TWO,
      'package-create-all-failed',
    );
    await database`
      UPDATE content_variants SET status = 'generation_failed'
      WHERE package_id = ${failed.package.id}::uuid
    `;
    await database`
      UPDATE content_packages SET status = 'all_failed'
      WHERE id = ${failed.package.id}::uuid
    `;
    expect(
      await database.begin((transaction) =>
        packages.abandon(
          transaction,
          SCOPE_A,
          failed.package.id,
          1,
          'All required variants failed',
          { requestId: 'all-failed-abandon' },
        ),
      ),
    ).toMatchObject({ package: { status: 'cancelled', version: 2 } });

    const inconsistent = await createPackage(
      database,
      packages,
      SCOPE_A,
      BRIEF_TWO,
      'package-create-inconsistent',
    );
    await database`
      UPDATE content_packages SET status = 'all_failed'
      WHERE id = ${inconsistent.package.id}::uuid
    `;
    await expect(
      database.begin((transaction) =>
        packages.abandon(
          transaction,
          SCOPE_A,
          inconsistent.package.id,
          1,
          'Summary does not match draft variants',
          { requestId: 'inconsistent-abandon' },
        ),
      ),
    ).rejects.toBeInstanceOf(ContentPackageStateError);
  });
});

async function createPackage(
  database: Sql,
  repository: ContentPackageRepository,
  scope: ContentScope,
  briefId: string,
  requestId: string,
): Promise<ContentPackageAggregate> {
  return database.begin((transaction) =>
    repository.createFromBrief(transaction, scope, briefId, { requestId }),
  );
}

async function insertRun(
  database: Sql,
  aggregate: ContentPackageAggregate,
  status: 'queued' | 'running',
  requestId: string,
): Promise<void> {
  const variant = aggregate.variants[0];
  if (!variant) throw new Error('Run seed requires one Variant');
  await database`
    INSERT INTO generation_runs (
      tenant_id, workspace_id, project_id, package_id, variant_id,
      skill_name, skill_version, prompt_version_id, model_key,
      status, input_hash, request_id, started_at
    ) VALUES (
      ${TENANT_ID}, ${WORKSPACE_A}, ${PROJECT_A}, ${aggregate.package.id}, ${variant.id},
      'content-writer', '1.0.0', ${'e4000000-0000-4000-8000-000000000045'},
      'mock-content-model', ${status}, ${'a'.repeat(64)}, ${requestId},
      ${status === 'running' ? new Date() : null}
    )
  `;
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status)
    VALUES
      (${CONTENT_ID}, 'package-content@example.com', 'Package Content', 'active'),
      (${STRATEGY_ID}, 'package-strategy@example.com', 'Package Strategy', 'active'),
      (${SCOPED_CONTENT_ID}, 'package-scoped@example.com', 'Package Scoped', 'active'),
      (${OTHER_OWNER_ID}, 'package-other@example.com', 'Package Other', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES
      (${TENANT_ID}, 'Package Tenant', 'package-tenant', 'active'),
      (${OTHER_TENANT_ID}, 'Other Package Tenant', 'other-package-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES
      (${TENANT_ID}, ${CONTENT_ID}, 'content_editor', 'active'),
      (${TENANT_ID}, ${STRATEGY_ID}, 'strategy_editor', 'active'),
      (${TENANT_ID}, ${SCOPED_CONTENT_ID}, 'content_editor', 'active'),
      (${OTHER_TENANT_ID}, ${OTHER_OWNER_ID}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES
      (${WORKSPACE_A}, ${TENANT_ID}, 'Package Workspace A', 'package-a', 'UTC'),
      (${WORKSPACE_B}, ${TENANT_ID}, 'Package Workspace B', 'package-b', 'UTC'),
      (${OTHER_WORKSPACE}, ${OTHER_TENANT_ID}, 'Other Workspace', 'package-other', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES
      (${PROJECT_A}, ${TENANT_ID}, ${WORKSPACE_A}, 'Package Project A', ${CONTENT_ID}),
      (${PROJECT_B}, ${TENANT_ID}, ${WORKSPACE_B}, 'Package Project B', ${CONTENT_ID}),
      (${OTHER_PROJECT}, ${OTHER_TENANT_ID}, ${OTHER_WORKSPACE}, 'Other Project', ${OTHER_OWNER_ID})
  `;
  await database`
    INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
    VALUES (
      ${WORKSPACE_B}, ${SCOPED_CONTENT_ID},
      ${JSON.stringify({ project_ids: [PROJECT_B], schema_version: 'workspace-scope@1' })}::text::jsonb
    )
  `;
  await database`
    INSERT INTO briefs (
      id, tenant_id, workspace_id, project_id, title, objective, audience,
      platform_codes, constraints_json, created_by
    ) VALUES
      (${BRIEF_A}, ${TENANT_ID}, ${WORKSPACE_A}, ${PROJECT_A}, 'Package Brief A', 'education',
        'Enterprise teams operating evidence-led GEO content programs',
        ARRAY['official_site','zhihu','wechat_mp'],
        '{"schema_version":"brief-constraints@1"}'::jsonb, ${CONTENT_ID}),
      (${BRIEF_TWO}, ${TENANT_ID}, ${WORKSPACE_A}, ${PROJECT_A}, 'Two Platform Brief', 'awareness',
        'Enterprise teams running a focused two-platform campaign',
        ARRAY['official_site','zhihu'],
        '{"schema_version":"brief-constraints@1"}'::jsonb, ${CONTENT_ID}),
      (${BRIEF_B}, ${TENANT_ID}, ${WORKSPACE_B}, ${PROJECT_B}, 'Package Brief B', 'awareness',
        'Enterprise teams in another isolated project and workspace',
        ARRAY['douyin'],
        '{"schema_version":"brief-constraints@1"}'::jsonb, ${CONTENT_ID})
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Package/Variant PostgreSQL client was not initialized');
  return client;
}
