import type { PlatformCode } from '@geo-content-os/contracts';
import {
  ContentGenerationWorker,
  type ContentWriterPort,
  type GeneratedContent,
  PostgresGenerationStore,
} from '@geo-content-os/worker-ai';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { GenerationRequestService } from '../../src/modules/ai/orchestrator/index.js';
import type { ContentScope } from '../../src/modules/content/index.js';
import { OutboxWriter } from '../../src/modules/outbox/index.js';

const USER_ID = '1a000000-0000-4000-8000-000000000053';
const TENANT_ID = '2a000000-0000-4000-8000-000000000053';
const WORKSPACE_ID = '3a000000-0000-4000-8000-000000000053';
const PROJECT_ID = '4a000000-0000-4000-8000-000000000053';
const BRIEF_ID = '5a000000-0000-4000-8000-000000000053';
const PACKAGE_ID = '6a000000-0000-4000-8000-000000000053';
const PROMPT_VERSION_ID = '8a000000-0000-4000-8000-000000000053';
const SCHEMA_VERSION = 'content-writer-data@1';
const PLATFORMS = [
  'official_site',
  'baijiahao',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
] as const satisfies readonly PlatformCode[];
const VARIANT_IDS = PLATFORMS.map(
  (_, index) => `7a000000-0000-4000-8000-000000000${String(53 + index).padStart(3, '0')}`,
);
const ACCOUNT_IDS = PLATFORMS.map(
  (_, index) => `9a000000-0000-4000-8000-000000000${String(53 + index).padStart(3, '0')}`,
);
const SCOPE: ContentScope = {
  projectId: PROJECT_ID,
  tenantId: TENANT_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

describe('Master and multi-platform generation orchestration', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 12 });
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

  it('queues one master and seven scoped variant runs, then generates them with bounded concurrency', async () => {
    const database = requireClient(client);
    const request = await schedule(database, 'generation-seven');
    expect(request.variantRuns).toHaveLength(7);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM generation_runs WHERE package_id = ${PACKAGE_ID}::uuid AND status = 'queued'
      `,
    ).toEqual([{ count: 8 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM content_variants WHERE package_id = ${PACKAGE_ID}::uuid AND status = 'generating'
      `,
    ).toEqual([{ count: 7 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM outbox_events WHERE event_type = 'content.package.generation_requested.v1'
      `,
    ).toEqual([{ count: 1 }]);

    const writer = new FakeWriter();
    const worker = new ContentGenerationWorker(new PostgresGenerationStore(database), writer, 3);
    await expect(worker.run(request.event)).resolves.toMatchObject({
      disposition: 'processed',
      failed: 0,
      packageStatus: 'generated',
      succeeded: 7,
    });
    expect(writer.maximumActiveVariants).toBeLessThanOrEqual(3);
    expect(writer.maximumActiveVariants).toBeGreaterThan(1);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM content_versions WHERE package_id = ${PACKAGE_ID}::uuid
      `,
    ).toEqual([{ count: 8 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM generation_runs WHERE package_id = ${PACKAGE_ID}::uuid AND status = 'succeeded'
      `,
    ).toEqual([{ count: 8 }]);

    const calls = writer.calls;
    await expect(worker.run(request.event)).resolves.toMatchObject({ disposition: 'completed' });
    expect(writer.calls).toBe(calls);
  });

  it('binds every generated variant to its single active platform account', async () => {
    const database = requireClient(client);
    await seedPlatformAccounts(database);
    const previous = process.env['CONTENT_REQUIRE_PLATFORM_ACCOUNTS'];
    process.env['CONTENT_REQUIRE_PLATFORM_ACCOUNTS'] = 'true';
    try {
      await schedule(database, 'generation-account-targets');
    } finally {
      if (previous === undefined) delete process.env['CONTENT_REQUIRE_PLATFORM_ACCOUNTS'];
      else process.env['CONTENT_REQUIRE_PLATFORM_ACCOUNTS'] = previous;
    }

    expect(
      await database<{ accountId: string; platformCode: string }[]>`
        SELECT
          platform_account_id AS "accountId",
          platform_code AS "platformCode"
        FROM content_variants
        WHERE package_id = ${PACKAGE_ID}::uuid
        ORDER BY platform_code
      `,
    ).toEqual(
      PLATFORMS.map((platformCode, index) => ({
        accountId: ACCOUNT_IDS[index]!,
        platformCode,
      })).sort((left, right) => left.platformCode.localeCompare(right.platformCode)),
    );
  });

  it('commits six successful variants when one platform generation fails', async () => {
    const database = requireClient(client);
    const request = await schedule(database, 'generation-partial');
    const writer = new FakeWriter(new Set(['zhihu']));
    const worker = new ContentGenerationWorker(new PostgresGenerationStore(database), writer, 3);

    await expect(worker.run(request.event)).resolves.toMatchObject({
      failed: 1,
      packageStatus: 'generated',
      succeeded: 6,
    });
    expect(
      await database<{ platformCode: string; status: string }[]>`
        SELECT platform_code AS "platformCode", status
        FROM content_variants WHERE package_id = ${PACKAGE_ID}::uuid
        ORDER BY platform_code
      `,
    ).toContainEqual({ platformCode: 'zhihu', status: 'generation_failed' });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM content_versions WHERE package_id = ${PACKAGE_ID}::uuid
      `,
    ).toEqual([{ count: 7 }]);
    expect(await packageStatus(database)).toBe('generated');
  });

  it('projects all_failed when every requested variant fails while retaining the master', async () => {
    const database = requireClient(client);
    const request = await schedule(database, 'generation-all-failed');
    const writer = new FakeWriter(new Set(PLATFORMS));
    const worker = new ContentGenerationWorker(new PostgresGenerationStore(database), writer, 4);

    await expect(worker.run(request.event)).resolves.toMatchObject({
      failed: 7,
      packageStatus: 'all_failed',
      succeeded: 0,
    });
    expect(await packageStatus(database)).toBe('all_failed');
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM content_versions WHERE package_id = ${PACKAGE_ID}::uuid
      `,
    ).toEqual([{ count: 1 }]);
  });

  it('rejects a locked block mutation without rolling back other successful variants', async () => {
    const database = requireClient(client);
    const lockedVariantId = VARIANT_IDS[0]!;
    const previousVersionId = await seedLockedVersion(database, lockedVariantId);
    const request = await schedule(database, 'generation-lock');
    const writer = new FakeWriter(new Set(), new Set(['official_site']));
    const worker = new ContentGenerationWorker(new PostgresGenerationStore(database), writer, 3);

    await expect(worker.run(request.event)).resolves.toMatchObject({
      failed: 1,
      packageStatus: 'generated',
      succeeded: 6,
    });
    expect(
      await database<{ currentId: string; status: string }[]>`
        SELECT current_content_version_id AS "currentId", status
        FROM content_variants WHERE id = ${lockedVariantId}::uuid
      `,
    ).toEqual([{ currentId: previousVersionId, status: 'generation_failed' }]);
    expect(
      await database<{ code: string }[]>`
        SELECT error_json->>'code' AS code
        FROM generation_runs WHERE variant_id = ${lockedVariantId}::uuid
      `,
    ).toEqual([{ code: 'LOCK_VIOLATION' }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM content_versions
        WHERE package_id = ${PACKAGE_ID}::uuid AND variant_id <> ${lockedVariantId}::uuid
      `,
    ).toEqual([{ count: 6 }]);
  });
});

class FakeWriter implements ContentWriterPort {
  public activeVariants = 0;
  public calls = 0;
  public maximumActiveVariants = 0;

  public constructor(
    private readonly failures = new Set<PlatformCode>(),
    private readonly lockMutations = new Set<PlatformCode>(),
  ) {}

  public async generateMaster(): Promise<GeneratedContent> {
    this.calls += 1;
    return document('master', 'Master evidence-led GEO content');
  }

  public async generateVariant(input: {
    readonly platformCode: PlatformCode;
  }): Promise<GeneratedContent> {
    this.calls += 1;
    this.activeVariants += 1;
    this.maximumActiveVariants = Math.max(this.maximumActiveVariants, this.activeVariants);
    // Keep the fake provider call open long enough for independently claimed
    // variant jobs to overlap even when the full integration suite is under load.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    this.activeVariants -= 1;
    if (this.failures.has(input.platformCode)) throw new Error('Provider rejected variant');
    const text = this.lockMutations.has(input.platformCode)
      ? 'Changed locked introduction'
      : 'Locked introduction';
    return document(input.platformCode, text);
  }
}

async function schedule(database: Sql, requestId: string) {
  const service = new GenerationRequestService(new OutboxWriter(database));
  return database.begin((transaction) =>
    service.request(
      transaction,
      { audit: { requestId }, scope: SCOPE },
      {
        expectedPackageVersion: 1,
        modelKey: 'deepseek-flash',
        modelPolicy: 'balanced',
        packageId: PACKAGE_ID,
        promptVersionId: PROMPT_VERSION_ID,
        skillVersion: '1.0.0',
        writerInput: {
          brief: { id: BRIEF_ID },
          generation_mode: 'draft',
          locked_blocks: [],
        },
      },
    ),
  );
}

function document(platformCode: PlatformCode | 'master', body: string): GeneratedContent {
  return {
    blocks: [
      { block_key: 'intro', block_type: 'heading', text: body },
      { block_key: 'body', block_type: 'paragraph', text: `Body for ${platformCode}` },
    ],
    citation_map: [],
    cta: null,
    hashtags: [],
    platform_code: platformCode,
    platform_meta: {},
    schema_version: SCHEMA_VERSION,
    summary: `Summary for ${platformCode}`,
    title: `Title for ${platformCode}`,
  };
}

async function seedLockedVersion(database: Sql, variantId: string): Promise<string> {
  const content = document('official_site', 'Locked introduction');
  const canonical = JSON.stringify(content);
  const hash = sha256(canonical);
  const versions = await database<{ id: string }[]>`
    INSERT INTO content_versions (
      tenant_id, package_id, variant_id, version_no, schema_version,
      content_json, content_hash, created_by
    ) VALUES (
      ${TENANT_ID}, ${PACKAGE_ID}, ${variantId}, 1, ${SCHEMA_VERSION},
      ${canonical}::text::jsonb, ${hash}, ${USER_ID}
    )
    RETURNING id
  `;
  const version = versions[0];
  if (!version) throw new Error('Lock fixture version insert failed');
  const blockHash = sha256('Locked introduction');
  await database`
    INSERT INTO content_blocks (
      tenant_id, content_version_id, block_key, block_type, position, text_hash
    ) VALUES
      (${TENANT_ID}, ${version.id}, 'intro', 'heading', 0, ${blockHash}),
      (${TENANT_ID}, ${version.id}, 'body', 'paragraph', 1, ${sha256('Body for official_site')})
  `;
  await database`
    UPDATE content_variants
    SET current_content_version_id = ${version.id}, status = 'generated'
    WHERE id = ${variantId}
  `;
  await database`
    INSERT INTO content_block_locks (
      tenant_id, variant_id, block_key, locked_content_hash, locked_by
    ) VALUES (${TENANT_ID}, ${variantId}, 'intro', ${blockHash}, ${USER_ID})
  `;
  return version.id;
}

async function packageStatus(database: Sql): Promise<string> {
  const rows = await database<{ status: string }[]>`
    SELECT status FROM content_packages WHERE id = ${PACKAGE_ID}::uuid
  `;
  return rows[0]?.status ?? '';
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status)
    VALUES (${USER_ID}, 'generation-content@example.com', 'Generation Content', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${TENANT_ID}, 'Generation Tenant', 'generation-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES (${TENANT_ID}, ${USER_ID}, 'content_editor', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES (${WORKSPACE_ID}, ${TENANT_ID}, 'Generation Workspace', 'generation-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES (${PROJECT_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 'Generation Project', ${USER_ID})
  `;
  await database`
    INSERT INTO briefs (
      id, tenant_id, workspace_id, project_id, title, objective, audience,
      platform_codes, constraints_json, created_by
    ) VALUES (
      ${BRIEF_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Generation Brief', 'trust',
      'Enterprise teams producing evidence-led multi-platform GEO content',
      ${PLATFORMS}::varchar[], '{"schema_version":"brief-constraints@1"}'::jsonb, ${USER_ID}
    )
  `;
  await database`
    INSERT INTO content_packages (
      id, tenant_id, workspace_id, project_id, brief_id, created_by
    ) VALUES (${PACKAGE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${BRIEF_ID}, ${USER_ID})
  `;
  for (const [index, platform] of PLATFORMS.entries()) {
    const variantId = VARIANT_IDS[index]!;
    await database`
      INSERT INTO content_variants (id, tenant_id, package_id, platform_code)
      VALUES (${variantId}, ${TENANT_ID}, ${PACKAGE_ID}, ${platform})
    `;
  }
}

async function seedPlatformAccounts(database: Sql): Promise<void> {
  for (const [index, platform] of PLATFORMS.entries()) {
    const accountId = ACCOUNT_IDS[index]!;
    await database`
      INSERT INTO platform_accounts (
        id, tenant_id, workspace_id, platform_code, provider_account_id,
        display_name, publish_mode, status, timezone
      ) VALUES (
        ${accountId}, ${TENANT_ID}, ${WORKSPACE_ID}, ${platform},
        ${`provider-${platform}`}, ${`Account ${platform}`}, 'manual', 'active', 'UTC'
      )
    `;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Generation PostgreSQL client was not initialized');
  return client;
}
