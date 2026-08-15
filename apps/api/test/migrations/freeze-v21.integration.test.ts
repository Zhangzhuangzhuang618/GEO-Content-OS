import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, migrationsFolder } from '../../src/database/migrate.js';
import { FREEZE_V21_SEED, seedFreezeV21 } from '../../src/database/seeds/freeze-v21.seed.js';

const FREEZE_TABLE_COUNT = 86;
const REQUIRED_HISTORY_TRIGGERS = [
  'ai_citations_append_only_guard',
  'ai_visibility_responses_append_only_guard',
  'audit_events_append_only_guard',
  'content_blocks_append_only_guard',
  'content_media_assets_append_only_guard',
  'content_versions_append_only_guard',
  'export_artifacts_append_only_guard',
  'fact_check_results_append_only_guard',
  'fact_evidences_append_only_guard',
  'fact_sources_append_only_guard',
  'invitations_history_delete_guard',
  'invitations_history_update_guard',
  'metric_records_append_only_guard',
  'model_rate_cards_history_guard',
  'password_reset_tokens_history_delete_guard',
  'password_reset_tokens_history_update_guard',
  'platform_rule_versions_history_guard',
  'prompt_versions_history_guard',
  'publish_attempts_append_only_guard',
  'quality_reports_append_only_guard',
  'review_actions_append_only_guard',
  'review_snapshot_citations_append_only_guard',
  'review_snapshot_variants_frozen_fields_guard',
  'review_snapshots_frozen_fields_guard',
  'support_access_grants_delete_guard',
  'support_access_grants_update_guard',
  'usage_ledger_append_only_guard',
  'visibility_observations_append_only_guard',
] as const;
const LATEST_MIGRATION = fileURLToPath(
  new URL('../../src/database/migrations/0030_freeze_v21.sql', import.meta.url),
);

async function expectDatabaseRejection(query: Promise<unknown>, message: RegExp): Promise<void> {
  await expect(query).rejects.toThrow(message);
}

async function countBusinessTables(client: Sql | TransactionSql): Promise<number> {
  const [result] = await client<{ count: number }[]>`
    SELECT count(*)::integer AS count
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `;
  return result?.count ?? 0;
}

describe('freeze v2.1 database verification', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 1 });
    await seedFreezeV21(client);
    await seedFreezeV21(client);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('migrates an empty database through T153 with browser publishing automation tables', async () => {
    if (!client) throw new Error('Database client did not start');

    const tables = await client<{ tablename: string }[]>`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
      ORDER BY tablename
    `;
    const migrationRows = await client<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM public.__drizzle_migrations
    `;
    const migrationFiles = (await readdir(migrationsFolder)).filter((file) =>
      file.endsWith('.sql'),
    );

    expect(tables).toHaveLength(FREEZE_TABLE_COUNT);
    expect(tables.map(({ tablename }) => tablename)).toEqual(
      expect.arrayContaining([
        'subscriptions',
        'model_rate_cards',
        'official_site_automation_policies',
        'official_site_automation_runs',
        'official_site_daily_batch_items',
        'official_site_daily_batches',
        'ai_visibility_queries',
        'ai_visibility_query_sets',
        'ai_visibility_responses',
        'ai_visibility_runs',
        'baijiahao_automation_policies',
        'baijiahao_automation_runs',
        'baijiahao_daily_batch_items',
        'baijiahao_daily_batches',
        'baijiahao_browser_sessions',
        'baijiahao_browser_publications',
        'baijiahao_browser_artifacts',
        'sohu_browser_sessions',
        'sohu_browser_publications',
        'sohu_browser_artifacts',
        'lieju_browser_sessions',
        'lieju_browser_publications',
        'lieju_browser_artifacts',
        'browser_platform_automation_policies',
        'browser_platform_automation_runs',
        'browser_platform_daily_batches',
        'browser_platform_daily_batch_items',
        'keyword_import_jobs',
        'keyword_import_candidates',
        'content_media_runs',
        'content_media_assets',
      ]),
    );
    expect(migrationRows[0]?.count).toBe(migrationFiles.length);
  });

  it('creates an idempotent and coherent demo seed', async () => {
    if (!client) throw new Error('Database client did not start');

    const [summary] = await client<
      {
        invitedOwners: number;
        modelRates: number;
        projects: number;
        rules: number;
        subscriptions: number;
        workspaces: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::integer FROM users WHERE email = 'owner@example.com' AND password_hash IS NULL AND status = 'invited') AS "invitedOwners",
        (SELECT count(*)::integer FROM subscriptions WHERE id = ${FREEZE_V21_SEED.subscriptionId}) AS subscriptions,
        (SELECT count(*)::integer FROM workspaces WHERE id = ${FREEZE_V21_SEED.workspaceId}) AS workspaces,
        (SELECT count(*)::integer FROM projects WHERE id = ${FREEZE_V21_SEED.projectId}) AS projects,
        (SELECT count(*)::integer FROM model_rate_cards WHERE id = ${FREEZE_V21_SEED.modelRateCardId}) AS "modelRates",
        (SELECT count(*)::integer FROM platform_rule_versions WHERE status = 'published') AS rules
    `;

    expect(summary).toEqual({
      invitedOwners: 1,
      modelRates: 1,
      projects: 1,
      rules: 8,
      subscriptions: 1,
      workspaces: 1,
    });
  });

  it('leaves every frozen constraint, index and history trigger valid', async () => {
    if (!client) throw new Error('Database client did not start');

    const invalidConstraints = await client<{ name: string; tableName: string }[]>`
      SELECT conname AS name, conrelid::regclass::text AS "tableName"
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND NOT convalidated
      ORDER BY conrelid::regclass::text, conname
    `;
    const invalidIndexes = await client<{ name: string; tableName: string }[]>`
      SELECT indexrelid::regclass::text AS name, indrelid::regclass::text AS "tableName"
      FROM pg_index
      WHERE indrelid::regclass::text NOT LIKE 'pg_%'
        AND (NOT indisvalid OR NOT indisready)
      ORDER BY indrelid::regclass::text, indexrelid::regclass::text
    `;
    const historyTriggers = await client<{ name: string }[]>`
      SELECT tgname AS name
      FROM pg_trigger
      WHERE tgrelid IN (
        SELECT table_name::regclass
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      )
        AND NOT tgisinternal
        AND tgname = ANY(${client.array([...REQUIRED_HISTORY_TRIGGERS])})
      ORDER BY tgname
    `;

    expect(invalidConstraints).toEqual([]);
    expect(invalidIndexes).toEqual([]);
    expect(historyTriggers.map(({ name }) => name)).toEqual([...REQUIRED_HISTORY_TRIGGERS].sort());
  });

  it('enforces foreign keys, checks, uniqueness and required indexes', async () => {
    if (!client) throw new Error('Database client did not start');

    const indexes = await client<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('subscriptions', 'model_rate_cards')
      ORDER BY indexname
    `;
    expect(indexes.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        'subscriptions_id_tenant_uq',
        'subscriptions_tenant_period_uq',
        'subscriptions_tenant_status_period_idx',
        'model_rate_cards_model_effective_uq',
        'model_rate_cards_model_effective_idx',
      ]),
    );

    await expectDatabaseRejection(
      client`
        INSERT INTO subscriptions (
          tenant_id, plan_code, status, period_start, period_end, quota_json
        ) VALUES (
          'ffffffff-ffff-4fff-8fff-ffffffffffff', 'growth', 'active',
          DATE '2026-01-01', DATE '2026-12-31', '{"schema_version":"quota@1"}'::jsonb
        )
      `,
      /subscriptions_tenant_fk/,
    );
    await expectDatabaseRejection(
      client`
        INSERT INTO subscriptions (
          tenant_id, plan_code, status, period_start, period_end, quota_json
        ) VALUES (
          '20000000-0000-4000-8000-000000000001', 'growth', 'paused',
          DATE '2027-01-01', DATE '2027-12-31', '{"schema_version":"quota@1"}'::jsonb
        )
      `,
      /subscriptions_status_check/,
    );
    await expectDatabaseRejection(
      client`
        INSERT INTO subscriptions (
          tenant_id, plan_code, status, period_start, period_end, quota_json
        ) VALUES (
          '20000000-0000-4000-8000-000000000001', 'growth', 'active',
          DATE '2027-12-31', DATE '2027-01-01', '{"schema_version":"quota@1"}'::jsonb
        )
      `,
      /subscriptions_period_check/,
    );
    await expectDatabaseRejection(
      client`
        INSERT INTO subscriptions (
          tenant_id, plan_code, status, period_start, period_end, quota_json
        ) VALUES (
          '20000000-0000-4000-8000-000000000001', 'growth', 'active',
          DATE '2027-01-01', DATE '2027-12-31', '{}'::jsonb
        )
      `,
      /subscriptions_quota_check/,
    );
    await expectDatabaseRejection(
      client`
        INSERT INTO model_rate_cards (
          model_key, provider, provider_model_id, capabilities_json,
          input_rate_micros, output_rate_micros, effective_from
        ) VALUES (
          'invalid-rate', 'deepseek', 'invalid-rate',
          '{"schema_version":"model-capability@1"}'::jsonb,
          -1, 1, TIMESTAMPTZ '2027-01-01T00:00:00Z'
        )
      `,
      /model_rate_cards_input_rate_check/,
    );
    await expectDatabaseRejection(
      client`
        INSERT INTO model_rate_cards (
          model_key, provider, provider_model_id, capabilities_json,
          input_rate_micros, output_rate_micros, effective_from, effective_to
        ) VALUES (
          'invalid-range', 'deepseek', 'invalid-range',
          '{"schema_version":"model-capability@1"}'::jsonb,
          1, 1, TIMESTAMPTZ '2027-02-01T00:00:00Z', TIMESTAMPTZ '2027-01-01T00:00:00Z'
        )
      `,
      /model_rate_cards_effective_range_check/,
    );
  });

  it('keeps model rate history append-only', async () => {
    if (!client) throw new Error('Database client did not start');

    await expectDatabaseRejection(
      client`
        UPDATE model_rate_cards
        SET input_rate_micros = 999
        WHERE id = ${FREEZE_V21_SEED.modelRateCardId}
      `,
      /model rate cards are append-only/,
    );
    await expectDatabaseRejection(
      client`DELETE FROM model_rate_cards WHERE id = ${FREEZE_V21_SEED.modelRateCardId}`,
      /model rate cards are append-only/,
    );
  });

  it('rolls back a replay of the latest migration without losing prior schema or data', async () => {
    if (!client) throw new Error('Database client did not start');

    const migrationSql = await readFile(LATEST_MIGRATION, 'utf8');
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    const rollbackMarker = new Error('intentional migration rollback');

    await expect(
      client.begin(async (transaction) => {
        await transaction`DROP TABLE model_rate_cards`;
        await transaction`DROP FUNCTION protect_model_rate_card_history()`;
        await transaction`DROP TABLE subscriptions`;
        expect(await countBusinessTables(transaction)).toBe(FREEZE_TABLE_COUNT - 2);

        for (const statement of statements) {
          await transaction.unsafe(statement);
        }
        expect(await countBusinessTables(transaction)).toBe(FREEZE_TABLE_COUNT);
        throw rollbackMarker;
      }),
    ).rejects.toBe(rollbackMarker);

    expect(await countBusinessTables(client)).toBe(FREEZE_TABLE_COUNT);
    const [seedRows] = await client<{ modelRates: number; subscriptions: number }[]>`
      SELECT
        (SELECT count(*)::integer FROM subscriptions WHERE id = ${FREEZE_V21_SEED.subscriptionId}) AS subscriptions,
        (SELECT count(*)::integer FROM model_rate_cards WHERE id = ${FREEZE_V21_SEED.modelRateCardId}) AS "modelRates"
    `;
    expect(seedRows).toEqual({ modelRates: 1, subscriptions: 1 });
  });
});
