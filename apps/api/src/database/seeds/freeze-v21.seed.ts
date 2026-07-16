import { createHash } from 'node:crypto';

import type { DatabaseClient } from '../connection.js';
import { IDENTITY_SEED, seedIdentity } from '../../modules/identity/seeds/identity.seed.js';

const PLATFORMS = [
  'official_site',
  'baijiahao',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
] as const;

export const FREEZE_V21_SEED = Object.freeze({
  modelRateCardId: '24000000-0000-4000-8000-000000000001',
  projectId: '23000000-0000-4000-8000-000000000001',
  promptVersionId: '25000000-0000-4000-8000-000000000001',
  subscriptionId: '22000000-0000-4000-8000-000000000001',
  workspaceId: '22000000-0000-4000-8000-000000000002',
  workspaceMembershipId: '22000000-0000-4000-8000-000000000003',
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function seedFreezeV21(client: DatabaseClient): Promise<void> {
  await seedIdentity(client);

  await client.begin(async (transaction) => {
    await transaction`
      INSERT INTO subscriptions (
        id, tenant_id, plan_code, status, period_start, period_end, quota_json
      ) VALUES (
        ${FREEZE_V21_SEED.subscriptionId},
        ${IDENTITY_SEED.tenantId},
        'growth',
        'active',
        DATE '2026-01-01',
        DATE '2026-12-31',
        ${transaction.json({
          schema_version: 'quota@1',
          monthly_ai_tokens: 10_000_000,
          monthly_publishes: 1_000,
        })}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    await transaction`
      INSERT INTO workspaces (id, tenant_id, name, slug, timezone, settings_json)
      VALUES (
        ${FREEZE_V21_SEED.workspaceId},
        ${IDENTITY_SEED.tenantId},
        'GEO 演示空间',
        'geo-demo',
        'Asia/Shanghai',
        ${transaction.json({ schema_version: 'workspace-settings@1' })}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    await transaction`
      INSERT INTO workspace_memberships (id, workspace_id, user_id, scope_json)
      VALUES (
        ${FREEZE_V21_SEED.workspaceMembershipId},
        ${FREEZE_V21_SEED.workspaceId},
        ${IDENTITY_SEED.userId},
        '{}'::jsonb
      )
      ON CONFLICT (id) DO NOTHING
    `;
    await transaction`
      INSERT INTO projects (
        id, tenant_id, workspace_id, name, owner_id, objective, start_date, end_date
      ) VALUES (
        ${FREEZE_V21_SEED.projectId},
        ${IDENTITY_SEED.tenantId},
        ${FREEZE_V21_SEED.workspaceId},
        'GEO 多平台演示项目',
        ${IDENTITY_SEED.userId},
        '演示从素材到多平台内容发布的冻结主链路',
        DATE '2026-01-01',
        DATE '2026-12-31'
      )
      ON CONFLICT (id) DO NOTHING
    `;
    await transaction`
      INSERT INTO model_rate_cards (
        id, model_key, provider, provider_model_id, capabilities_json,
        input_rate_micros, output_rate_micros, currency, effective_from
      ) VALUES (
        ${FREEZE_V21_SEED.modelRateCardId},
        'deepseek-v4-flash',
        'deepseek',
        'deepseek-v4-flash',
        ${transaction.json({
          schema_version: 'model-capability@1',
          structured_output: true,
          tool_calling: true,
        })},
        1000,
        2000,
        'CNY',
        TIMESTAMPTZ '2026-01-01T00:00:00Z'
      )
      ON CONFLICT (id) DO NOTHING
    `;

    const systemPrompt = '你是 GEO Content OS 的企业内容生产助手。';
    const taskTemplate = '依据已核验素材生成可追溯的多平台内容。';
    await transaction`
      INSERT INTO prompt_versions (
        id, skill_name, version, schema_version, system_prompt, task_template,
        content_hash, status, created_by, published_at, change_summary, published_by
      ) VALUES (
        ${FREEZE_V21_SEED.promptVersionId},
        'content-writer',
        '1.0.0',
        'prompt@1',
        ${systemPrompt},
        ${taskTemplate},
        ${sha256(`${systemPrompt}\n${taskTemplate}`)},
        'published',
        ${IDENTITY_SEED.userId},
        TIMESTAMPTZ '2026-01-01T00:00:00Z',
        'Freeze v2.1 demo prompt',
        ${IDENTITY_SEED.userId}
      )
      ON CONFLICT (id) DO NOTHING
    `;

    for (const [index, platformCode] of PLATFORMS.entries()) {
      const rules = {
        schema_version: 'platform-rules@1',
        platform_code: platformCode,
        require_citations: true,
      };
      const serializedRules = JSON.stringify(rules);
      const id = `26000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      await transaction`
        INSERT INTO platform_rule_versions (
          id, platform_code, version, rules_json, content_hash, status,
          created_by, published_at, change_summary, published_by
        ) VALUES (
          ${id},
          ${platformCode},
          '1.0.0',
          ${transaction.json(rules)},
          ${sha256(serializedRules)},
          'published',
          ${IDENTITY_SEED.userId},
          TIMESTAMPTZ '2026-01-01T00:00:00Z',
          'Freeze v2.1 demo platform rule',
          ${IDENTITY_SEED.userId}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }

    const [summary] = await transaction<
      {
        modelKey: string | null;
        projectName: string | null;
        prompts: number;
        rules: number;
        subscriptionPlan: string | null;
        subscriptionStatus: string | null;
        workspaceName: string | null;
      }[]
    >`
      SELECT
        (SELECT plan_code FROM subscriptions WHERE id = ${FREEZE_V21_SEED.subscriptionId}) AS "subscriptionPlan",
        (SELECT status FROM subscriptions WHERE id = ${FREEZE_V21_SEED.subscriptionId}) AS "subscriptionStatus",
        (SELECT name FROM workspaces WHERE id = ${FREEZE_V21_SEED.workspaceId}) AS "workspaceName",
        (SELECT name FROM projects WHERE id = ${FREEZE_V21_SEED.projectId}) AS "projectName",
        (SELECT model_key FROM model_rate_cards WHERE id = ${FREEZE_V21_SEED.modelRateCardId}) AS "modelKey",
        (SELECT count(*)::integer FROM prompt_versions WHERE id = ${FREEZE_V21_SEED.promptVersionId}) AS prompts,
        (SELECT count(*)::integer FROM platform_rule_versions WHERE version = '1.0.0') AS rules
    `;

    if (
      !summary ||
      summary.subscriptionPlan !== 'growth' ||
      summary.subscriptionStatus !== 'active' ||
      summary.workspaceName !== 'GEO 演示空间' ||
      summary.projectName !== 'GEO 多平台演示项目' ||
      summary.modelKey !== 'deepseek-v4-flash' ||
      summary.prompts !== 1 ||
      summary.rules !== PLATFORMS.length
    ) {
      throw new Error('Freeze v2.1 seed conflicts with existing rows');
    }
  });
}
