import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import type { ContentDocument } from '../../src/database/schema/index.js';
import {
  ContentBlockLockNotFoundError,
  ContentBlockLockRepository,
  ContentBlockLockStateError,
  ContentBlockLockValidationError,
  ContentBlockLockVersionConflictError,
  ContentBlockLockViolationError,
  ContentVersionRepository,
  type ContentScope,
  type ContentVersionDetail,
} from '../../src/modules/content/index.js';

const CONTENT_USER = '17000000-0000-4000-8000-000000000047';
const STRATEGY_USER = '17000000-0000-4000-8000-000000000147';
const OTHER_USER = '17000000-0000-4000-8000-000000000247';
const TENANT_ID = '27000000-0000-4000-8000-000000000047';
const OTHER_TENANT_ID = '27000000-0000-4000-8000-000000000147';
const WORKSPACE_ID = '37000000-0000-4000-8000-000000000047';
const OTHER_WORKSPACE_ID = '37000000-0000-4000-8000-000000000147';
const PROJECT_ID = '47000000-0000-4000-8000-000000000047';
const OTHER_PROJECT_ID = '47000000-0000-4000-8000-000000000147';
const BRIEF_ID = '57000000-0000-4000-8000-000000000047';
const OTHER_BRIEF_ID = '57000000-0000-4000-8000-000000000147';
const PACKAGE_ID = '67000000-0000-4000-8000-000000000047';
const OTHER_PACKAGE_ID = '67000000-0000-4000-8000-000000000147';
const VARIANT_ID = '77000000-0000-4000-8000-000000000047';
const OTHER_VARIANT_ID = '77000000-0000-4000-8000-000000000147';
const SCHEMA_VERSION = 'content-writer-data@1';

const SCOPE: ContentScope = {
  projectId: PROJECT_ID,
  tenantId: TENANT_ID,
  userId: CONTENT_USER,
  workspaceId: WORKSPACE_ID,
};

describe('Content Block Lock repository', () => {
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

  it('locks a current block by id while persisting its stable key and exact text hash', async () => {
    const database = requireClient(client);
    const version = await createCurrentVersion(database);
    const repository = new ContentBlockLockRepository(database);
    const target = version.blocks[0]!;
    const result = await database.begin((transaction) =>
      repository.lock(
        transaction,
        SCOPE,
        VARIANT_ID,
        target.id,
        2,
        '  Preserve verified introduction  ',
        { ip: '127.0.0.1', requestId: 'lock-intro' },
      ),
    );

    expect(result).toMatchObject({
      lock: {
        blockKey: 'intro',
        lockedBy: CONTENT_USER,
        lockedContentHash: target.textHash,
        reason: 'Preserve verified introduction',
        variantId: VARIANT_ID,
      },
      variantVersion: 3,
    });
    expect(await repository.list(SCOPE, VARIANT_ID)).toEqual([result.lock]);
    expect(
      await database<{ version: number }[]>`
        SELECT version FROM content_variants WHERE id = ${VARIANT_ID}
      `,
    ).toEqual([{ version: 3 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM audit_events WHERE action = 'content_block.locked'
      `,
    ).toEqual([{ count: 1 }]);
  });

  it('accepts regeneration only when every locked block keeps byte-identical text', async () => {
    const database = requireClient(client);
    const version = await createCurrentVersion(database);
    const repository = new ContentBlockLockRepository(database);
    await database.begin((transaction) =>
      repository.lock(transaction, SCOPE, VARIANT_ID, version.blocks[0]!.id, 2, null, {
        requestId: 'guard-lock',
      }),
    );

    await expect(
      repository.assertRegenerationPreservesLocks(
        SCOPE,
        VARIANT_ID,
        document([
          block('body', 'paragraph', 'A regenerated unlocked body.'),
          block('intro', 'heading', 'Locked introduction'),
        ]),
      ),
    ).resolves.toHaveLength(1);
    await expect(
      repository.assertRegenerationPreservesLocks(
        SCOPE,
        VARIANT_ID,
        document([
          block('intro', 'heading', 'Locked introduction '),
          block('body', 'paragraph', 'A regenerated unlocked body.'),
        ]),
      ),
    ).rejects.toEqual(expect.objectContaining({ blockKey: 'intro' }));
    await expect(
      repository.assertRegenerationPreservesLocks(
        SCOPE,
        VARIANT_ID,
        document([block('body', 'paragraph', 'Locked key was removed.')]),
      ),
    ).rejects.toBeInstanceOf(ContentBlockLockViolationError);
    await expect(
      repository.assertRegenerationPreservesLocks(
        SCOPE,
        VARIANT_ID,
        document([
          block('intro', 'heading', 'Locked introduction'),
          block('intro', 'heading', 'Duplicate key'),
        ]),
      ),
    ).rejects.toBeInstanceOf(ContentBlockLockValidationError);
  });

  it('unlocks by current block id, increments Variant version, and rejects stale requests', async () => {
    const database = requireClient(client);
    const version = await createCurrentVersion(database);
    const repository = new ContentBlockLockRepository(database);
    const target = version.blocks[1]!;
    const locked = await database.begin((transaction) =>
      repository.lock(
        transaction,
        SCOPE,
        VARIANT_ID,
        target.id,
        2,
        'Allow body regeneration later',
        { requestId: 'lock-body' },
      ),
    );
    await expect(
      database.begin((transaction) =>
        repository.unlock(transaction, SCOPE, VARIANT_ID, target.id, 2, {
          requestId: 'stale-unlock',
        }),
      ),
    ).rejects.toBeInstanceOf(ContentBlockLockVersionConflictError);

    const unlocked = await database.begin((transaction) =>
      repository.unlock(transaction, SCOPE, VARIANT_ID, target.id, 3, {
        requestId: 'unlock-body',
      }),
    );
    expect(unlocked).toEqual({ lockId: locked.lock.id, variantVersion: 4 });
    expect(await repository.list(SCOPE, VARIANT_ID)).toEqual([]);
    expect(
      await database<{ beforeKey: string }[]>`
        SELECT before_json->>'blockKey' AS "beforeKey"
        FROM audit_events WHERE action = 'content_block.unlocked'
      `,
    ).toEqual([{ beforeKey: 'body' }]);
    await expect(
      database.begin((transaction) =>
        repository.unlock(transaction, SCOPE, VARIANT_ID, target.id, 4, {
          requestId: 'unlock-missing',
        }),
      ),
    ).rejects.toBeInstanceOf(ContentBlockLockNotFoundError);
  });

  it('serializes concurrent lock changes with the Variant optimistic version', async () => {
    const database = requireClient(client);
    const version = await createCurrentVersion(database);
    const repository = new ContentBlockLockRepository(database);
    const results = await Promise.allSettled([
      database.begin((transaction) =>
        repository.lock(transaction, SCOPE, VARIANT_ID, version.blocks[0]!.id, 2, null, {
          requestId: 'concurrent-lock-a',
        }),
      ),
      database.begin((transaction) =>
        repository.lock(transaction, SCOPE, VARIANT_ID, version.blocks[1]!.id, 2, null, {
          requestId: 'concurrent-lock-b',
        }),
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')?.reason).toBeInstanceOf(
      ContentBlockLockVersionConflictError,
    );
    expect(await repository.list(SCOPE, VARIANT_ID)).toHaveLength(1);
  });

  it('rejects non-current block ids, duplicate locks, forged scopes, and unauthorized roles', async () => {
    const database = requireClient(client);
    const version = await createCurrentVersion(database);
    const repository = new ContentBlockLockRepository(database);
    const target = version.blocks[0]!;
    await expect(
      database.begin((transaction) =>
        repository.lock(transaction, SCOPE, VARIANT_ID, OTHER_VARIANT_ID, 2, null, {
          requestId: 'forged-block',
        }),
      ),
    ).rejects.toBeInstanceOf(ContentBlockLockNotFoundError);
    await database.begin((transaction) =>
      repository.lock(transaction, SCOPE, VARIANT_ID, target.id, 2, null, {
        requestId: 'first-lock',
      }),
    );
    await expect(
      database.begin((transaction) =>
        repository.lock(transaction, SCOPE, VARIANT_ID, target.id, 3, null, {
          requestId: 'duplicate-lock',
        }),
      ),
    ).rejects.toBeInstanceOf(ContentBlockLockStateError);
    await expect(
      database.begin((transaction) =>
        repository.lock(
          transaction,
          { ...SCOPE, userId: STRATEGY_USER },
          VARIANT_ID,
          version.blocks[1]!.id,
          3,
          null,
          { requestId: 'unauthorized-lock' },
        ),
      ),
    ).rejects.toBeInstanceOf(ContentBlockLockNotFoundError);
    expect(
      await repository.list(
        {
          projectId: OTHER_PROJECT_ID,
          tenantId: OTHER_TENANT_ID,
          userId: OTHER_USER,
          workspaceId: OTHER_WORKSPACE_ID,
        },
        VARIANT_ID,
      ),
    ).toEqual([]);
    await expect(
      repository.assertRegenerationPreservesLocks(
        {
          projectId: OTHER_PROJECT_ID,
          tenantId: OTHER_TENANT_ID,
          userId: OTHER_USER,
          workspaceId: OTHER_WORKSPACE_ID,
        },
        VARIANT_ID,
        document([block('body', 'paragraph', 'Forged guard scope')]),
      ),
    ).rejects.toBeInstanceOf(ContentBlockLockNotFoundError);
  });
});

async function createCurrentVersion(database: Sql): Promise<ContentVersionDetail> {
  const repository = new ContentVersionRepository(database);
  return database.begin((transaction) =>
    repository.create(
      transaction,
      SCOPE,
      {
        contentJson: document([
          block('intro', 'heading', 'Locked introduction'),
          block('body', 'paragraph', 'Editable body'),
        ]),
        expectedVersion: 1,
        packageId: PACKAGE_ID,
        schemaVersion: SCHEMA_VERSION,
        variantId: VARIANT_ID,
      },
      { requestId: 'seed-current-version' },
    ),
  );
}

function document(blocks: readonly ReturnType<typeof block>[]): ContentDocument {
  return {
    blocks,
    citation_map: [],
    cta: null,
    hashtags: [],
    platform_code: 'zhihu',
    platform_meta: {},
    schema_version: SCHEMA_VERSION,
    summary: 'Stable block locks',
    title: 'Stable block locks',
  };
}

function block(blockKey: string, blockType: 'heading' | 'paragraph', text: string) {
  return { block_key: blockKey, block_type: blockType, text } as const;
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status) VALUES
      (${CONTENT_USER}, 'locks-content@example.com', 'Locks Content', 'active'),
      (${STRATEGY_USER}, 'locks-strategy@example.com', 'Locks Strategy', 'active'),
      (${OTHER_USER}, 'locks-other@example.com', 'Locks Other', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status) VALUES
      (${TENANT_ID}, 'Locks Tenant', 'locks-tenant', 'active'),
      (${OTHER_TENANT_ID}, 'Other Locks Tenant', 'other-locks-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status) VALUES
      (${TENANT_ID}, ${CONTENT_USER}, 'content_editor', 'active'),
      (${TENANT_ID}, ${STRATEGY_USER}, 'strategy_editor', 'active'),
      (${OTHER_TENANT_ID}, ${OTHER_USER}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone) VALUES
      (${WORKSPACE_ID}, ${TENANT_ID}, 'Locks Workspace', 'locks-workspace', 'UTC'),
      (${OTHER_WORKSPACE_ID}, ${OTHER_TENANT_ID}, 'Other Locks Workspace', 'other-locks-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id) VALUES
      (${PROJECT_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 'Locks Project', ${CONTENT_USER}),
      (${OTHER_PROJECT_ID}, ${OTHER_TENANT_ID}, ${OTHER_WORKSPACE_ID}, 'Other Locks Project', ${OTHER_USER})
  `;
  await database`
    INSERT INTO briefs (
      id, tenant_id, workspace_id, project_id, title, objective, audience,
      platform_codes, constraints_json, created_by
    ) VALUES
      (${BRIEF_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Locks Brief', 'trust',
        'Enterprise GEO teams', ARRAY['zhihu'], '{"schema_version":"brief-constraints@1"}'::jsonb,
        ${CONTENT_USER}),
      (${OTHER_BRIEF_ID}, ${OTHER_TENANT_ID}, ${OTHER_WORKSPACE_ID}, ${OTHER_PROJECT_ID},
        'Other Locks Brief', 'trust', 'Other tenant teams', ARRAY['zhihu'],
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
  if (!client) throw new Error('Content Block Lock PostgreSQL client was not initialized');
  return client;
}
