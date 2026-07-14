import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import type { ContentDocument } from '../../src/database/schema/index.js';
import {
  ContentVersionNotFoundError,
  ContentVersionRepository,
  ContentVersionStateError,
  ContentVersionValidationError,
  ContentVersionVersionConflictError,
  type ContentScope,
} from '../../src/modules/content/index.js';

const CONTENT_USER = '16000000-0000-4000-8000-000000000046';
const STRATEGY_USER = '16000000-0000-4000-8000-000000000146';
const OTHER_USER = '16000000-0000-4000-8000-000000000246';
const TENANT_ID = '26000000-0000-4000-8000-000000000046';
const OTHER_TENANT_ID = '26000000-0000-4000-8000-000000000146';
const WORKSPACE_ID = '36000000-0000-4000-8000-000000000046';
const OTHER_WORKSPACE_ID = '36000000-0000-4000-8000-000000000146';
const PROJECT_ID = '46000000-0000-4000-8000-000000000046';
const OTHER_PROJECT_ID = '46000000-0000-4000-8000-000000000146';
const BRIEF_ID = '56000000-0000-4000-8000-000000000046';
const OTHER_BRIEF_ID = '56000000-0000-4000-8000-000000000146';
const PACKAGE_ID = '66000000-0000-4000-8000-000000000046';
const OTHER_PACKAGE_ID = '66000000-0000-4000-8000-000000000146';
const VARIANT_ID = '76000000-0000-4000-8000-000000000046';
const OTHER_VARIANT_ID = '76000000-0000-4000-8000-000000000146';
const SCHEMA_VERSION = 'content-writer-data@1';

const SCOPE: ContentScope = {
  projectId: PROJECT_ID,
  tenantId: TENANT_ID,
  userId: CONTENT_USER,
  workspaceId: WORKSPACE_ID,
};

describe('Content Version repository', () => {
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

  it('creates immutable master and Variant versions with structured block projections', async () => {
    const database = requireClient(client);
    const repository = new ContentVersionRepository(database);
    const master = await database.begin((transaction) =>
      repository.create(
        transaction,
        SCOPE,
        {
          contentJson: document('master', 'Enterprise GEO master', [
            block('intro', 'heading', 'Enterprise GEO'),
            block('body-1', 'paragraph', 'Evidence-led content remains traceable.'),
          ]),
          expectedVersion: 1,
          packageId: PACKAGE_ID,
          schemaVersion: SCHEMA_VERSION,
          variantId: null,
        },
        { requestId: 'master-create' },
      ),
    );
    const variant = await database.begin((transaction) =>
      repository.create(
        transaction,
        SCOPE,
        {
          contentJson: document('zhihu', 'How enterprise GEO stays traceable', [
            block('answer', 'paragraph', 'Start with evidence and preserve citations.'),
          ]),
          expectedVersion: 1,
          packageId: PACKAGE_ID,
          schemaVersion: SCHEMA_VERSION,
          variantId: VARIANT_ID,
        },
        { ip: '127.0.0.1', requestId: 'variant-create' },
      ),
    );

    expect(master).toMatchObject({ packageId: PACKAGE_ID, variantId: null, versionNo: 1 });
    expect(master.blocks.map((item) => [item.blockKey, item.position])).toEqual([
      ['intro', 0],
      ['body-1', 1],
    ]);
    expect(variant).toMatchObject({ packageId: PACKAGE_ID, variantId: VARIANT_ID, versionNo: 1 });
    expect(variant.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(variant.blocks[0]?.textHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await repository.find(SCOPE, variant.id)).toEqual(variant);
    expect(await repository.list(SCOPE, PACKAGE_ID, VARIANT_ID)).toEqual([variant]);

    expect(
      await database<
        {
          masterId: string | null;
          packageVersion: number;
          variantId: string | null;
          variantVersion: number;
        }[]
      >`
        SELECT
          package.master_content_version_id AS "masterId",
          package.version AS "packageVersion",
          variant.current_content_version_id AS "variantId",
          variant.version AS "variantVersion"
        FROM content_packages AS package
        JOIN content_variants AS variant ON variant.package_id = package.id
        WHERE package.id = ${PACKAGE_ID}
      `,
    ).toEqual([
      {
        masterId: master.id,
        packageVersion: 2,
        variantId: variant.id,
        variantVersion: 2,
      },
    ]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM audit_events WHERE action = 'content_version.created'
      `,
    ).toEqual([{ count: 2 }]);

    await expect(
      database`UPDATE content_versions SET content_hash = ${'f'.repeat(64)} WHERE id = ${variant.id}`,
    ).rejects.toThrow(/content versions are append-only/u);
    await expect(
      database`DELETE FROM content_blocks WHERE content_version_id = ${variant.id}`,
    ).rejects.toThrow(/content blocks are append-only/u);
  });

  it('diffs structured content and rolls the current pointer back without rewriting history', async () => {
    const database = requireClient(client);
    const repository = new ContentVersionRepository(database);
    const first = await createVariant(repository, database, 1, 'version-1', [
      block('intro', 'heading', 'Traceable GEO'),
      block('body', 'paragraph', 'Version one body.'),
    ]);
    const second = await createVariant(repository, database, 2, 'version-2', [
      block('intro', 'heading', 'Traceable enterprise GEO'),
      block('proof', 'quote', 'Every claim links to evidence.'),
    ]);

    expect(await repository.diff(SCOPE, first.id, second.id)).toMatchObject({
      base: { id: first.id, versionNo: 1 },
      blocks: [
        { blockKey: 'body', change: 'removed' },
        { blockKey: 'intro', change: 'modified' },
        { blockKey: 'proof', change: 'added' },
      ],
      fields: [
        {
          after: 'version-2 summary',
          before: 'version-1 summary',
          field: 'summary',
        },
        { after: 'version-2', before: 'version-1', field: 'title' },
      ],
      target: { id: second.id, versionNo: 2 },
    });

    const rolledBack = await database.begin((transaction) =>
      repository.rollback(transaction, SCOPE, first.id, 3, { requestId: 'rollback-v1' }),
    );
    expect(rolledBack).toEqual(first);
    expect(
      await database<{ currentId: string; version: number }[]>`
        SELECT current_content_version_id AS "currentId", version
        FROM content_variants WHERE id = ${VARIANT_ID}
      `,
    ).toEqual([{ currentId: first.id, version: 4 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM content_versions WHERE variant_id = ${VARIANT_ID}
      `,
    ).toEqual([{ count: 2 }]);
    expect(
      await database<{ beforeId: string }[]>`
        SELECT before_json->>'content_version_id' AS "beforeId"
        FROM audit_events WHERE action = 'content_version.rolled_back'
      `,
    ).toEqual([{ beforeId: second.id }]);
    await expect(
      database.begin((transaction) =>
        repository.rollback(transaction, SCOPE, first.id, 4, { requestId: 'rollback-current' }),
      ),
    ).rejects.toBeInstanceOf(ContentVersionStateError);
  });

  it('enforces optimistic locking and serializes concurrent version allocation', async () => {
    const database = requireClient(client);
    const repository = new ContentVersionRepository(database);
    const results = await Promise.allSettled([
      createVariant(repository, database, 1, 'concurrent-a', [
        block('body', 'paragraph', 'Concurrent body A'),
      ]),
      createVariant(repository, database, 1, 'concurrent-b', [
        block('body', 'paragraph', 'Concurrent body B'),
      ]),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ContentVersionVersionConflictError);
    expect(
      await database<{ count: number; maxVersion: number }[]>`
        SELECT count(*)::integer AS count, max(version_no)::integer AS "maxVersion"
        FROM content_versions WHERE variant_id = ${VARIANT_ID}
      `,
    ).toEqual([{ count: 1, maxVersion: 1 }]);
  });

  it('rejects duplicate canonical content, malformed blocks, and a mismatched platform', async () => {
    const database = requireClient(client);
    const repository = new ContentVersionRepository(database);
    const original = document('zhihu', 'Canonical content', [
      block('body', 'paragraph', 'Canonical body'),
    ]);
    await database.begin((transaction) =>
      repository.create(
        transaction,
        SCOPE,
        {
          contentJson: original,
          expectedVersion: 1,
          packageId: PACKAGE_ID,
          schemaVersion: SCHEMA_VERSION,
          variantId: VARIANT_ID,
        },
        { requestId: 'canonical-first' },
      ),
    );
    const reordered = {
      ...original,
      blocks: original.blocks,
      schema_version: SCHEMA_VERSION,
    } as ContentDocument;
    await expect(
      database.begin((transaction) =>
        repository.create(
          transaction,
          SCOPE,
          {
            contentJson: reordered,
            expectedVersion: 2,
            packageId: PACKAGE_ID,
            schemaVersion: SCHEMA_VERSION,
            variantId: VARIANT_ID,
          },
          { requestId: 'canonical-duplicate' },
        ),
      ),
    ).rejects.toBeInstanceOf(ContentVersionStateError);

    await expect(
      database.begin((transaction) =>
        repository.create(
          transaction,
          SCOPE,
          {
            contentJson: {
              ...document('zhihu', 'Duplicate keys', [block('same', 'paragraph', 'One')]),
              blocks: [block('same', 'paragraph', 'One'), block('same', 'paragraph', 'Two')],
            },
            expectedVersion: 2,
            packageId: PACKAGE_ID,
            schemaVersion: SCHEMA_VERSION,
            variantId: VARIANT_ID,
          },
          { requestId: 'duplicate-blocks' },
        ),
      ),
    ).rejects.toBeInstanceOf(ContentVersionValidationError);
    await expect(
      database.begin((transaction) =>
        repository.create(
          transaction,
          SCOPE,
          {
            contentJson: document('douyin', 'Wrong platform', [
              block('body', 'paragraph', 'Wrong platform body'),
            ]),
            expectedVersion: 2,
            packageId: PACKAGE_ID,
            schemaVersion: SCHEMA_VERSION,
            variantId: VARIANT_ID,
          },
          { requestId: 'wrong-platform' },
        ),
      ),
    ).rejects.toBeInstanceOf(ContentVersionValidationError);
  });

  it('hides cross-tenant and unauthorized resources for reads and writes', async () => {
    const database = requireClient(client);
    const repository = new ContentVersionRepository(database);
    const first = await createVariant(repository, database, 1, 'visible', [
      block('body', 'paragraph', 'Visible only in the correct scope.'),
    ]);
    expect(
      await repository.find(
        {
          projectId: OTHER_PROJECT_ID,
          tenantId: OTHER_TENANT_ID,
          userId: OTHER_USER,
          workspaceId: OTHER_WORKSPACE_ID,
        },
        first.id,
      ),
    ).toBeUndefined();
    await expect(
      database.begin((transaction) =>
        repository.create(
          transaction,
          { ...SCOPE, userId: STRATEGY_USER },
          {
            contentJson: document('zhihu', 'Unauthorized', [
              block('body', 'paragraph', 'Unauthorized body'),
            ]),
            expectedVersion: 2,
            packageId: PACKAGE_ID,
            schemaVersion: SCHEMA_VERSION,
            variantId: VARIANT_ID,
          },
          { requestId: 'unauthorized-write' },
        ),
      ),
    ).rejects.toBeInstanceOf(ContentVersionNotFoundError);
    await expect(repository.diff(SCOPE, first.id, OTHER_VARIANT_ID)).rejects.toBeInstanceOf(
      ContentVersionNotFoundError,
    );
  });
});

async function createVariant(
  repository: ContentVersionRepository,
  database: Sql,
  expectedVersion: number,
  title: string,
  blocks: readonly ReturnType<typeof block>[],
) {
  return database.begin((transaction) =>
    repository.create(
      transaction,
      SCOPE,
      {
        contentJson: document('zhihu', title, blocks),
        expectedVersion,
        packageId: PACKAGE_ID,
        schemaVersion: SCHEMA_VERSION,
        variantId: VARIANT_ID,
      },
      { requestId: `create-${title}` },
    ),
  );
}

function document(
  platformCode: 'douyin' | 'master' | 'zhihu',
  title: string,
  blocks: readonly ReturnType<typeof block>[],
): ContentDocument {
  return {
    blocks,
    citation_map: [],
    cta: null,
    hashtags: [],
    platform_code: platformCode,
    platform_meta: {},
    schema_version: SCHEMA_VERSION,
    summary: `${title} summary`,
    title,
  };
}

function block(blockKey: string, blockType: 'heading' | 'paragraph' | 'quote', text: string) {
  return { block_key: blockKey, block_type: blockType, text } as const;
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status) VALUES
      (${CONTENT_USER}, 'versions-content@example.com', 'Versions Content', 'active'),
      (${STRATEGY_USER}, 'versions-strategy@example.com', 'Versions Strategy', 'active'),
      (${OTHER_USER}, 'versions-other@example.com', 'Versions Other', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status) VALUES
      (${TENANT_ID}, 'Versions Tenant', 'versions-tenant', 'active'),
      (${OTHER_TENANT_ID}, 'Other Versions Tenant', 'other-versions-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status) VALUES
      (${TENANT_ID}, ${CONTENT_USER}, 'content_editor', 'active'),
      (${TENANT_ID}, ${STRATEGY_USER}, 'strategy_editor', 'active'),
      (${OTHER_TENANT_ID}, ${OTHER_USER}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone) VALUES
      (${WORKSPACE_ID}, ${TENANT_ID}, 'Versions Workspace', 'versions-workspace', 'UTC'),
      (${OTHER_WORKSPACE_ID}, ${OTHER_TENANT_ID}, 'Other Versions Workspace', 'other-versions-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id) VALUES
      (${PROJECT_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 'Versions Project', ${CONTENT_USER}),
      (${OTHER_PROJECT_ID}, ${OTHER_TENANT_ID}, ${OTHER_WORKSPACE_ID}, 'Other Versions Project', ${OTHER_USER})
  `;
  await database`
    INSERT INTO briefs (
      id, tenant_id, workspace_id, project_id, title, objective, audience,
      platform_codes, constraints_json, created_by
    ) VALUES
      (${BRIEF_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Versions Brief', 'trust',
        'Enterprise GEO teams', ARRAY['zhihu'], '{"schema_version":"brief-constraints@1"}'::jsonb,
        ${CONTENT_USER}),
      (${OTHER_BRIEF_ID}, ${OTHER_TENANT_ID}, ${OTHER_WORKSPACE_ID}, ${OTHER_PROJECT_ID},
        'Other Versions Brief', 'trust', 'Other tenant teams', ARRAY['zhihu'],
        '{"schema_version":"brief-constraints@1"}'::jsonb, ${OTHER_USER})
  `;
  await database`
    INSERT INTO content_packages (
      id, tenant_id, workspace_id, project_id, brief_id, created_by
    ) VALUES
      (${PACKAGE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${BRIEF_ID}, ${CONTENT_USER}),
      (${OTHER_PACKAGE_ID}, ${OTHER_TENANT_ID}, ${OTHER_WORKSPACE_ID}, ${OTHER_PROJECT_ID},
        ${OTHER_BRIEF_ID}, ${OTHER_USER})
  `;
  await database`
    INSERT INTO content_variants (id, tenant_id, package_id, platform_code) VALUES
      (${VARIANT_ID}, ${TENANT_ID}, ${PACKAGE_ID}, 'zhihu'),
      (${OTHER_VARIANT_ID}, ${OTHER_TENANT_ID}, ${OTHER_PACKAGE_ID}, 'zhihu')
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Content Version PostgreSQL client was not initialized');
  return client;
}
