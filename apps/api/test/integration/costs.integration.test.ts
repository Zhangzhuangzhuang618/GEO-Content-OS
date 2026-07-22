import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from '../../src/database/connection.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import {
  CostQueryService,
  CostQueryStateError,
  CostQueryValidationError,
  type CostQueryScope,
} from '../../src/modules/billing/costs/index.js';

const OWNER = '1c000000-0000-4000-8000-000000000131';
const VIEWER = '1c000000-0000-4000-8000-000000000231';
const TENANT = '2c000000-0000-4000-8000-000000000131';
const WORKSPACE = '3c000000-0000-4000-8000-000000000131';
const PROJECT = '4c000000-0000-4000-8000-000000000131';
const BRIEF = '5c000000-0000-4000-8000-000000000131';
const PACKAGE = '6c000000-0000-4000-8000-000000000131';
const VARIANT = '7c000000-0000-4000-8000-000000000131';
const RUN = '8c000000-0000-4000-8000-000000000131';
const SCOPE: CostQueryScope = { tenantId: TENANT, userId: OWNER };
const JULY = { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' };

describe('cost queries', () => {
  let client: Sql | undefined;
  let serviceClient: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
    serviceClient = createDatabaseConnection(container.getConnectionUri()).client;
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`
      TRUNCATE usage_ledger, ai_citations, content_block_locks, content_blocks,
        content_versions, content_variants, content_packages, fact_sources, facts,
        embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs,
        source_documents, topic_candidates, generation_runs, keywords, keyword_sets,
        brand_profiles, workspace_memberships, projects, workspaces, audit_events,
        outbox_events, support_access_grants, idempotency_records, password_reset_tokens,
        invitations, sessions, platform_roles, memberships, tenants, users CASCADE
    `;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await serviceClient?.end();
    await container?.stop();
  });

  it('reports package full costs from effective settlements across all attribution fields', async () => {
    const database = requireClient(client);
    await insertLifecycle(database, {
      category: 'llm',
      costCents: 150,
      currency: 'CNY',
      provider: 'deepseek',
      requestId: 'cost-deepseek',
    });
    await insertLifecycle(database, {
      category: 'storage',
      costCents: 20,
      currency: 'CNY',
      provider: 'object-storage',
      requestId: 'cost-storage',
    });
    await insertLifecycle(database, {
      category: 'llm',
      costCents: 10,
      currency: 'USD',
      provider: 'openai',
      requestId: 'cost-usd',
    });
    await insertLifecycle(database, {
      category: 'llm',
      costCents: 30,
      currency: 'CNY',
      provider: 'deepseek',
      requestId: 'cost-reversed',
      reverse: true,
    });
    await insertLifecycle(database, {
      category: 'llm',
      costCents: 999,
      currency: 'CNY',
      provider: 'deepseek',
      requestId: 'cost-outside-range',
      settledAt: '2026-06-20T00:00:01Z',
    });

    const report = await new CostQueryService(requireClient(serviceClient)).report(SCOPE, JULY);
    expect(report.settledOnly).toBe(true);
    expect(report.totals).toEqual([
      { costCents: 170, currency: 'CNY', entryCount: 2 },
      { costCents: 10, currency: 'USD', entryCount: 1 },
    ]);
    expect(report.packageTotals).toEqual([
      { costCents: 170, currency: 'CNY', entryCount: 2, packageId: PACKAGE },
      { costCents: 10, currency: 'USD', entryCount: 1, packageId: PACKAGE },
    ]);
    expect(report.breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          costCents: 150,
          generationRunId: RUN,
          modelKey: 'deepseek-flash',
          packageId: PACKAGE,
          projectId: PROJECT,
          skillName: 'content-writer',
          variantId: VARIANT,
          workspaceId: WORKSPACE,
        }),
      ]),
    );
  });

  it('calculates the workspace monthly CNY budget from settled non-reversed costs', async () => {
    const database = requireClient(client);
    await insertLifecycle(database, {
      category: 'llm',
      costCents: 170,
      currency: 'CNY',
      provider: 'deepseek',
      requestId: 'budget-settled',
    });
    await insertEstimate(database, {
      category: 'llm',
      costCents: 500,
      currency: 'CNY',
      provider: 'deepseek',
      requestId: 'budget-estimate-only',
    });

    await expect(
      new CostQueryService(requireClient(serviceClient)).budget(SCOPE, {
        month: '2026-07',
        workspaceId: WORKSPACE,
      }),
    ).resolves.toEqual({
      consumedCents: 170,
      currency: 'CNY',
      hardLimit: true,
      isExceeded: true,
      isExhausted: true,
      limitCents: 150,
      month: '2026-07',
      remainingCents: 0,
      workspaceId: WORKSPACE,
    });

    await database`UPDATE workspaces SET settings_json = '{}'::jsonb WHERE id = ${WORKSPACE}`;
    await expect(
      new CostQueryService(requireClient(serviceClient)).budget(SCOPE, {
        month: '2026-07',
        workspaceId: WORKSPACE,
      }),
    ).resolves.toMatchObject({ hardLimit: false, limitCents: null, remainingCents: null });
  });

  it('reconciles provider statement lines without inventing a supplier invoice table', async () => {
    const database = requireClient(client);
    await insertLifecycle(database, {
      category: 'llm',
      costCents: 150,
      currency: 'CNY',
      provider: 'deepseek',
      requestId: 'reconcile-deepseek',
    });
    await insertLifecycle(database, {
      category: 'storage',
      costCents: 20,
      currency: 'CNY',
      provider: 'object-storage',
      requestId: 'reconcile-storage',
    });
    await insertLifecycle(database, {
      category: 'queue',
      costCents: 5,
      currency: 'CNY',
      provider: null,
      requestId: 'reconcile-unattributed',
    });

    const result = await new CostQueryService(requireClient(serviceClient)).reconcileProviders(
      SCOPE,
      JULY,
      [
        { billedCostCents: 150, currency: 'CNY', provider: 'deepseek' },
        { billedCostCents: 25, currency: 'CNY', provider: 'object-storage' },
        { billedCostCents: 8, currency: 'CNY', provider: 'unused-provider' },
      ],
    );
    expect(result.items).toEqual([
      {
        billedCostCents: null,
        currency: 'CNY',
        deltaCents: null,
        ledgerCostCents: 5,
        provider: null,
        status: 'missing_statement',
      },
      {
        billedCostCents: 150,
        currency: 'CNY',
        deltaCents: 0,
        ledgerCostCents: 150,
        provider: 'deepseek',
        status: 'matched',
      },
      {
        billedCostCents: 25,
        currency: 'CNY',
        deltaCents: -5,
        ledgerCostCents: 20,
        provider: 'object-storage',
        status: 'mismatch',
      },
      {
        billedCostCents: 8,
        currency: 'CNY',
        deltaCents: -8,
        ledgerCostCents: 0,
        provider: 'unused-provider',
        status: 'missing_ledger',
      },
    ]);
  });

  it('enforces cost roles and validates date, UUID, currency, and statement uniqueness', async () => {
    const service = new CostQueryService(requireClient(serviceClient));
    await expect(service.report({ tenantId: TENANT, userId: VIEWER }, JULY)).rejects.toBeInstanceOf(
      CostQueryStateError,
    );
    await expect(service.report(SCOPE, { ...JULY, currency: 'invalid' })).rejects.toBeInstanceOf(
      CostQueryValidationError,
    );
    await expect(
      service.budget(SCOPE, { month: '0000-01', workspaceId: WORKSPACE }),
    ).rejects.toBeInstanceOf(CostQueryValidationError);
    await expect(
      service.reconcileProviders(SCOPE, JULY, [
        { billedCostCents: 1, currency: 'CNY', provider: 'deepseek' },
        { billedCostCents: 2, currency: 'CNY', provider: 'deepseek' },
      ]),
    ).rejects.toBeInstanceOf(CostQueryValidationError);
  });
});

interface LedgerInput {
  readonly category: 'llm' | 'queue' | 'storage';
  readonly costCents: number;
  readonly currency: string;
  readonly provider: string | null;
  readonly requestId: string;
  readonly reverse?: boolean;
  readonly settledAt?: string;
}

async function insertLifecycle(database: Sql, input: LedgerInput): Promise<void> {
  const settledAt = input.settledAt ?? '2026-07-15T00:00:01Z';
  const estimatedAt = new Date(new Date(settledAt).getTime() - 1_000).toISOString();
  await insertEstimate(database, input, estimatedAt);
  const rows = await database<{ id: string }[]>`
    INSERT INTO usage_ledger (
      tenant_id, workspace_id, project_id, package_id, variant_id, generation_run_id,
      request_id, cost_category, provider, model_key, skill_name, quantity, unit,
      input_tokens, output_tokens, cost_cents, currency, status, created_at
    ) VALUES (
      ${TENANT}, ${WORKSPACE}, ${PROJECT}, ${PACKAGE}, ${VARIANT}, ${RUN},
      ${input.requestId}, ${input.category}, ${input.provider}, 'deepseek-flash',
      'content-writer', 100, 'token', 80, 20, ${input.costCents}, ${input.currency},
      'settled', ${settledAt}
    ) RETURNING id
  `;
  if (!input.reverse) return;
  const settlementId = rows[0]?.id;
  if (!settlementId) throw new Error('Cost settlement insert failed');
  await database`
    INSERT INTO usage_ledger (
      tenant_id, workspace_id, project_id, package_id, variant_id, generation_run_id,
      request_id, cost_category, provider, model_key, skill_name, quantity, unit,
      input_tokens, output_tokens, cost_cents, currency, status, reverses_ledger_id, created_at
    ) VALUES (
      ${TENANT}, ${WORKSPACE}, ${PROJECT}, ${PACKAGE}, ${VARIANT}, ${RUN},
      ${`${input.requestId}-reversal`}, ${input.category}, ${input.provider}, 'deepseek-flash',
      'content-writer', 100, 'token', 80, 20, ${-input.costCents}, ${input.currency},
      'reversed', ${settlementId}, ${new Date(new Date(settledAt).getTime() + 1_000).toISOString()}
    )
  `;
}

function insertEstimate(database: Sql, input: LedgerInput, createdAt = '2026-07-15T00:00:00Z') {
  return database`
    INSERT INTO usage_ledger (
      tenant_id, workspace_id, project_id, package_id, variant_id, generation_run_id,
      request_id, cost_category, provider, model_key, skill_name, quantity, unit,
      input_tokens, output_tokens, cost_cents, currency, status, created_at
    ) VALUES (
      ${TENANT}, ${WORKSPACE}, ${PROJECT}, ${PACKAGE}, ${VARIANT}, ${RUN},
      ${input.requestId}, ${input.category}, ${input.provider}, 'deepseek-flash',
      'content-writer', 100, 'token', 80, 20, ${input.costCents}, ${input.currency},
      'estimated', ${createdAt}
    )
  `;
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id,email,display_name,status) VALUES
      (${OWNER},'cost-owner@example.com','Cost Owner','active'),
      (${VIEWER},'cost-viewer@example.com','Cost Viewer','active')
  `;
  await database`
    INSERT INTO tenants (id,name,slug,status)
    VALUES (${TENANT},'Cost Tenant','cost-tenant','active')
  `;
  await database`
    INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES
      (${TENANT},${OWNER},'tenant_owner','active'),
      (${TENANT},${VIEWER},'viewer','active')
  `;
  await database`
    INSERT INTO workspaces (id,tenant_id,name,slug,timezone,settings_json)
    VALUES (
      ${WORKSPACE},${TENANT},'Cost Workspace','cost-workspace','UTC',
      ${database.json({
        budget_policy: { hard_limit: true, monthly_limit_cny: 1.5 },
        schema_version: 'workspace-settings@1',
      })}
    )
  `;
  await database`
    INSERT INTO projects (id,tenant_id,workspace_id,name,owner_id)
    VALUES (${PROJECT},${TENANT},${WORKSPACE},'Cost Project',${OWNER})
  `;
  await database`
    INSERT INTO briefs (
      id,tenant_id,workspace_id,project_id,title,objective,audience,
      platform_codes,constraints_json,created_by
    ) VALUES (
      ${BRIEF},${TENANT},${WORKSPACE},${PROJECT},'Cost Brief','trust',
      'Enterprise cost reconciliation team',ARRAY['zhihu'],
      '{"schema_version":"brief-constraints@1"}'::jsonb,${OWNER}
    )
  `;
  await database`
    INSERT INTO content_packages (id,tenant_id,workspace_id,project_id,brief_id,created_by)
    VALUES (${PACKAGE},${TENANT},${WORKSPACE},${PROJECT},${BRIEF},${OWNER})
  `;
  await database`
    INSERT INTO content_variants (id,tenant_id,package_id,platform_code)
    VALUES (${VARIANT},${TENANT},${PACKAGE},'zhihu')
  `;
  await database`
    INSERT INTO generation_runs (
      id,tenant_id,workspace_id,project_id,package_id,variant_id,skill_name,
      skill_version,prompt_version_id,model_key,input_hash,request_id
    ) VALUES (
      ${RUN},${TENANT},${WORKSPACE},${PROJECT},${PACKAGE},${VARIANT},'content-writer',
      '1.0.0',${'9c000000-0000-4000-8000-000000000131'},'deepseek-flash',
      ${'a'.repeat(64)},'cost-generation-run'
    )
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Cost PostgreSQL client is not initialized');
  return client;
}
