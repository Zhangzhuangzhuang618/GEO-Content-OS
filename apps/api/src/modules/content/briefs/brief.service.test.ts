import { BriefPageSchema } from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import type { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import type { BriefCostEstimator } from './brief-cost-estimator.js';
import { BriefService } from './brief.service.js';

const TENANT_ID = '20000000-0000-4000-8000-000000000001';
const USER_ID = '05154ba4-b6f3-44ae-867e-b9033b8b70db';

describe('BriefService public serialization', () => {
  it('keeps daily automation metadata internal when listing Briefs', async () => {
    const row = dailyBriefRow();
    const client = vi.fn(async () => [row]);
    const service = new BriefService(
      { client } as unknown as IdentityAuthDatabase,
      {} as BriefCostEstimator,
    );

    const result = await service.list(TENANT_ID, USER_ID, { limit: 20 });

    expect(result.items[0]?.constraints).toEqual({
      additional_instructions: '只使用提供的企业资料。',
      cta: null,
      schema_version: 'brief-constraints@1',
    });
    expect(
      BriefPageSchema.safeParse({
        data: result.items,
        meta: {
          next_cursor: result.nextCursor,
          request_id: '77eebd23-f394-4f70-b4fc-2ea38ecd4249',
        },
      }).success,
    ).toBe(true);
  });

  it('preserves internal automation metadata when public Brief fields are updated', async () => {
    const row = dailyBriefRow();
    let storedConstraints: Record<string, unknown> | undefined;
    const transaction = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM memberships AS membership')) return [{ valid: true }];
      if (sql.includes('FROM briefs AS brief')) return [row];
      if (sql.includes('FROM keywords AS keyword')) return [{ id: row.primaryKeywordId }];
      if (sql.includes('FROM source_documents AS source')) return [{ id: row.sourceIds[0] }];
      if (sql.includes('UPDATE briefs')) {
        const serialized = values.find(
          (value): value is string =>
            typeof value === 'string' && value.includes('"schema_version":"brief-constraints@1"'),
        );
        if (!serialized) throw new Error('Updated constraints were not serialized');
        storedConstraints = JSON.parse(serialized) as Record<string, unknown>;
        return [{ ...row, constraints: storedConstraints, version: 2 }];
      }
      if (sql.includes('INSERT INTO audit_events')) {
        return [{ id: 'f31baf14-1370-4992-a500-f9ab5d04af45' }];
      }
      return [];
    });
    const service = new BriefService({} as IdentityAuthDatabase, {} as BriefCostEstimator);

    const result = await service.update(
      transaction as unknown as TransactionSql,
      TENANT_ID,
      USER_ID,
      row.id,
      row.version,
      {
        audience: row.audience,
        constraints: {
          additional_instructions: '更新后的公开写作要求。',
          cta: null,
          schema_version: 'brief-constraints@1',
        },
        due_at: '2026-07-30T23:59:59.000Z',
        keyword_ids: row.keywordIds,
        objective: row.objective,
        platform_codes: [...row.platformCodes],
        primary_keyword_id: row.primaryKeywordId,
        source_ids: row.sourceIds,
        title: row.title,
      },
      { requestId: '77eebd23-f394-4f70-b4fc-2ea38ecd4249' },
    );

    expect(storedConstraints).toMatchObject({
      additional_instructions: '更新后的公开写作要求。',
      official_site_direct: true,
      target_accounts_by_code: row.constraints.target_accounts_by_code,
    });
    expect(result.constraints).toEqual({
      additional_instructions: '更新后的公开写作要求。',
      cta: null,
      schema_version: 'brief-constraints@1',
    });
  });
});

function dailyBriefRow() {
  return {
    audience: '正在搜索广州搬家公司相关信息并准备做出决策的目标用户',
    constraints: {
      additional_instructions: '只使用提供的企业资料。',
      cta: null,
      official_site_direct: true,
      schema_version: 'brief-constraints@1',
      target_accounts_by_code: {
        official_site: {
          account_id: '291357e2-c0c4-44ff-aab9-e1c7228ec884',
          display_name: '官网生产账号',
        },
      },
    },
    createdAt: '2026-07-29 17:18:29.130+00',
    createdBy: USER_ID,
    dueAt: '2026-07-30 23:59:59.000+00',
    id: '20ccb489-e8f7-4eb4-9473-7eff02b13f2e',
    keywordIds: ['dc449c23-86a4-403b-8ecf-0e09846f858c'],
    objective: 'awareness' as const,
    platformCodes: ['official_site'] as const,
    primaryKeywordId: 'dc449c23-86a4-403b-8ecf-0e09846f858c',
    projectId: '23000000-0000-4000-8000-000000000001',
    sourceIds: ['59a178d3-d08f-4c08-8e4d-15c938ea246d'],
    sourceTopicCandidateId: null,
    tenantId: TENANT_ID,
    title: '广州搬家公司推荐需要提前准备哪些信息和资料',
    updatedAt: '2026-07-29 17:18:29.130+00',
    version: 1,
    workspaceId: '22000000-0000-4000-8000-000000000002',
  };
}
