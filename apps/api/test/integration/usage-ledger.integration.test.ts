import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  UsageLedgerError,
  UsageLedgerRepository,
  type UsageAttribution,
  type UsageMeasurementInput,
} from '../../src/modules/billing/usage/index.js';

const USER_ID = '1b000000-0000-4000-8000-000000000056';
const TENANT_ID = '2b000000-0000-4000-8000-000000000056';
const OTHER_TENANT_ID = '2b000000-0000-4000-8000-000000000156';
const WORKSPACE_ID = '3b000000-0000-4000-8000-000000000056';
const OTHER_WORKSPACE_ID = '3b000000-0000-4000-8000-000000000156';
const PROJECT_ID = '4b000000-0000-4000-8000-000000000056';
const OTHER_PROJECT_ID = '4b000000-0000-4000-8000-000000000156';
const BRIEF_ID = '5b000000-0000-4000-8000-000000000056';
const PACKAGE_ID = '6b000000-0000-4000-8000-000000000056';
const VARIANT_ID = '7b000000-0000-4000-8000-000000000056';
const RUN_ID = '8b000000-0000-4000-8000-000000000056';

const ATTRIBUTION: UsageAttribution = {
  generationRunId: RUN_ID,
  packageId: PACKAGE_ID,
  projectId: PROJECT_ID,
  tenantId: TENANT_ID,
  variantId: VARIANT_ID,
  workspaceId: WORKSPACE_ID,
};

describe('Usage ledger repository', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 8 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE usage_ledger, ai_citations, content_block_locks, content_blocks, content_versions, content_variants, content_packages, fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('reconciles an estimate to actual settled usage across every ownership dimension', async () => {
    const database = requireClient(client);
    const repository = new UsageLedgerRepository(database);
    const estimate = await database.begin((transaction) =>
      repository.estimate(transaction, ATTRIBUTION, measurement(120, 3_000, 2_000, 1_000)),
    );
    const settled = await database.begin((transaction) =>
      repository.settle(transaction, ATTRIBUTION, measurement(75, 1_800, 1_500, 300)),
    );

    expect(estimate).toMatchObject({ costCents: 120, status: 'estimated' });
    expect(settled).toMatchObject({
      costCents: 75,
      generationRunId: RUN_ID,
      packageId: PACKAGE_ID,
      projectId: PROJECT_ID,
      status: 'settled',
      variantId: VARIANT_ID,
      workspaceId: WORKSPACE_ID,
    });
    await expect(
      repository.reconcile(ATTRIBUTION, 'usage-request-0001', 'llm'),
    ).resolves.toMatchObject({
      effectiveCostCents: 75,
      effectiveEntry: { id: settled.id },
      state: 'settled',
    });
    await expect(repository.summarize({ ...ATTRIBUTION, currency: 'CNY' })).resolves.toEqual({
      currency: 'CNY',
      effectiveCostCents: 75,
      entryCount: 1,
    });
  });

  it('appends an exact reversal, reconciles to zero, and never mutates history', async () => {
    const database = requireClient(client);
    const repository = new UsageLedgerRepository(database);
    await database.begin((transaction) =>
      repository.estimate(transaction, ATTRIBUTION, measurement(120, 3_000, 2_000, 1_000)),
    );
    const settled = await database.begin((transaction) =>
      repository.settle(transaction, ATTRIBUTION, measurement(75, 1_800, 1_500, 300)),
    );
    const reversed = await database.begin((transaction) =>
      repository.reverse(transaction, ATTRIBUTION, {
        costCategory: 'llm',
        originalRequestId: 'usage-request-0001',
        reversalRequestId: 'usage-reversal-0001',
      }),
    );
    const replay = await database.begin((transaction) =>
      repository.reverse(transaction, ATTRIBUTION, {
        costCategory: 'llm',
        originalRequestId: 'usage-request-0001',
        reversalRequestId: 'usage-reversal-replay',
      }),
    );

    expect(reversed).toMatchObject({
      costCents: -75,
      reversesLedgerId: settled.id,
      status: 'reversed',
    });
    expect(replay.id).toBe(reversed.id);
    await expect(
      repository.reconcile(ATTRIBUTION, 'usage-request-0001', 'llm'),
    ).resolves.toMatchObject({
      effectiveCostCents: 0,
      effectiveEntry: null,
      state: 'reversed',
    });
    await expect(repository.summarize({ ...ATTRIBUTION, currency: 'CNY' })).resolves.toEqual({
      currency: 'CNY',
      effectiveCostCents: 0,
      entryCount: 0,
    });
    await expect(
      database`UPDATE usage_ledger SET cost_cents = 1 WHERE id = ${settled.id}::uuid`,
    ).rejects.toThrow(/append-only/u);
  });

  it('serializes concurrent estimates and rejects request reuse with different usage', async () => {
    const database = requireClient(client);
    const repository = new UsageLedgerRepository(database);
    const [first, second] = await Promise.all([
      database.begin((transaction) =>
        repository.estimate(transaction, ATTRIBUTION, measurement(120, 3_000, 2_000, 1_000)),
      ),
      database.begin((transaction) =>
        repository.estimate(transaction, ATTRIBUTION, measurement(120, 3_000, 2_000, 1_000)),
      ),
    ]);

    expect(first.id).toBe(second.id);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM usage_ledger WHERE status = 'estimated'
      `,
    ).toEqual([{ count: 1 }]);
    await expect(
      database.begin((transaction) =>
        repository.estimate(transaction, ATTRIBUTION, measurement(121, 3_000, 2_000, 1_000)),
      ),
    ).rejects.toBeInstanceOf(UsageLedgerError);
  });

  it('rejects forged generation-run attribution and cross-tenant reads', async () => {
    const database = requireClient(client);
    const repository = new UsageLedgerRepository(database);
    await expect(
      database.begin((transaction) =>
        repository.estimate(
          transaction,
          { ...ATTRIBUTION, projectId: OTHER_PROJECT_ID, workspaceId: OTHER_WORKSPACE_ID },
          measurement(120, 3_000, 2_000, 1_000),
        ),
      ),
    ).rejects.toThrow();
    await database.begin((transaction) =>
      repository.estimate(transaction, ATTRIBUTION, measurement(120, 3_000, 2_000, 1_000)),
    );
    await expect(
      repository.reconcile(
        { ...ATTRIBUTION, tenantId: OTHER_TENANT_ID },
        'usage-request-0001',
        'llm',
      ),
    ).rejects.toMatchObject({ code: 'USAGE_NOT_FOUND' });
  });

  it('enforces estimate-before-settlement and exact reversal at the database boundary', async () => {
    const database = requireClient(client);
    await expect(
      insertRawLedger(database, {
        costCents: 10,
        requestId: 'raw-settlement-no-estimate',
        status: 'settled',
      }),
    ).rejects.toThrow(/matching estimate/u);
    const repository = new UsageLedgerRepository(database);
    const estimate = await database.begin((transaction) =>
      repository.estimate(transaction, ATTRIBUTION, measurement(120, 3_000, 2_000, 1_000)),
    );
    await expect(
      database`
        INSERT INTO usage_ledger (
          tenant_id, workspace_id, project_id, package_id, variant_id, generation_run_id,
          request_id, cost_category, provider, model_key, skill_name, quantity, unit,
          input_tokens, output_tokens, cost_cents, currency, status, reverses_ledger_id
        ) VALUES (
          ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${PACKAGE_ID}, ${VARIANT_ID}, ${RUN_ID},
          'raw-invalid-reversal', 'llm', 'deepseek', 'deepseek-flash', 'content-writer',
          3000, 'token', 2000, 1000, -119, 'CNY', 'reversed', ${estimate.id}
        )
      `,
    ).rejects.toThrow(/exactly match/u);
    await database.begin((transaction) =>
      repository.reverse(transaction, ATTRIBUTION, {
        costCategory: 'llm',
        originalRequestId: 'usage-request-0001',
        reversalRequestId: 'reverse-estimate-before-settlement',
      }),
    );
    await expect(
      database`
        INSERT INTO usage_ledger (
          tenant_id, workspace_id, project_id, package_id, variant_id, generation_run_id,
          request_id, cost_category, provider, model_key, skill_name, quantity, unit,
          input_tokens, output_tokens, cost_cents, currency, status
        ) VALUES (
          ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${PACKAGE_ID}, ${VARIANT_ID}, ${RUN_ID},
          'usage-request-0001', 'llm', 'deepseek', 'deepseek-flash', 'content-writer',
          100, 'token', 80, 20, 10, 'CNY', 'settled'
        )
      `,
    ).rejects.toThrow(/matching estimate/u);
  });
});

function measurement(
  costCents: number,
  quantity: number,
  inputTokens: number,
  outputTokens: number,
): UsageMeasurementInput {
  return {
    costCategory: 'llm',
    costCents,
    currency: 'CNY',
    inputTokens,
    modelKey: 'deepseek-flash',
    outputTokens,
    provider: 'deepseek',
    quantity,
    requestId: 'usage-request-0001',
    skillName: 'content-writer',
    unit: 'token',
  };
}

function insertRawLedger(
  database: Sql,
  input: { readonly costCents: number; readonly requestId: string; readonly status: string },
) {
  return database`
    INSERT INTO usage_ledger (
      tenant_id, workspace_id, project_id, package_id, variant_id, generation_run_id,
      request_id, cost_category, provider, model_key, skill_name, quantity, unit,
      input_tokens, output_tokens, cost_cents, currency, status
    ) VALUES (
      ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${PACKAGE_ID}, ${VARIANT_ID}, ${RUN_ID},
      ${input.requestId}, 'llm', 'deepseek', 'deepseek-flash', 'content-writer',
      10, 'token', 5, 5, ${input.costCents}, 'CNY', ${input.status}
    )
  `;
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status)
    VALUES (${USER_ID}, 'usage-owner@example.com', 'Usage Owner', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status) VALUES
      (${TENANT_ID}, 'Usage Tenant', 'usage-tenant', 'active'),
      (${OTHER_TENANT_ID}, 'Other Usage Tenant', 'other-usage-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES (${TENANT_ID}, ${USER_ID}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone) VALUES
      (${WORKSPACE_ID}, ${TENANT_ID}, 'Usage Workspace', 'usage-workspace', 'UTC'),
      (${OTHER_WORKSPACE_ID}, ${OTHER_TENANT_ID}, 'Other Usage Workspace', 'other-usage-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id) VALUES
      (${PROJECT_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 'Usage Project', ${USER_ID})
  `;
  await database`
    INSERT INTO briefs (
      id, tenant_id, workspace_id, project_id, title, objective, audience,
      platform_codes, constraints_json, created_by
    ) VALUES (
      ${BRIEF_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Usage Brief', 'trust',
      'Enterprise teams reconciling model costs', ARRAY['zhihu'],
      '{"schema_version":"brief-constraints@1"}'::jsonb, ${USER_ID}
    )
  `;
  await database`
    INSERT INTO content_packages (
      id, tenant_id, workspace_id, project_id, brief_id, created_by
    ) VALUES (${PACKAGE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${BRIEF_ID}, ${USER_ID})
  `;
  await database`
    INSERT INTO content_variants (id, tenant_id, package_id, platform_code)
    VALUES (${VARIANT_ID}, ${TENANT_ID}, ${PACKAGE_ID}, 'zhihu')
  `;
  await database`
    INSERT INTO generation_runs (
      id, tenant_id, workspace_id, project_id, package_id, variant_id,
      skill_name, skill_version, prompt_version_id, model_key, input_hash, request_id
    ) VALUES (
      ${RUN_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${PACKAGE_ID}, ${VARIANT_ID},
      'content-writer', '1.0.0', ${'9b000000-0000-4000-8000-000000000056'},
      'deepseek-flash', ${'a'.repeat(64)}, 'generation-request-0056'
    )
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Usage ledger PostgreSQL client was not initialized');
  return client;
}
