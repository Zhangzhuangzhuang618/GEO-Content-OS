import {
  AccountContentPolicyViewSchema,
  supportsEditorialStyle,
  type AccountContentPolicyRequest,
  type AccountContentPolicyView,
} from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import { resolveDatabaseClient, type DatabaseClientSource } from '../../../database/index.js';
import { PlatformAccountError } from './platform-account.errors.js';
import type { PlatformAccountAudit, PlatformAccountScope } from './platform-account.types.js';

export class AccountContentPolicyService {
  public constructor(private readonly databaseSource: DatabaseClientSource) {}

  public async get(
    scope: PlatformAccountScope,
    accountId: string,
  ): Promise<AccountContentPolicyView> {
    const client = resolveDatabaseClient(this.databaseSource);
    return client.begin((transaction) =>
      AccountContentPolicyService.getInTransaction(transaction, scope, accountId),
    );
  }

  public async saveInTransaction(
    transaction: TransactionSql,
    scope: PlatformAccountScope,
    accountId: string,
    input: AccountContentPolicyRequest,
    audit: PlatformAccountAudit,
  ): Promise<AccountContentPolicyView> {
    const before = await AccountContentPolicyService.getInTransaction(
      transaction,
      scope,
      accountId,
    );
    if (before.version !== input.expected_version) {
      throw new PlatformAccountError(
        'PLATFORM_ACCOUNT_VERSION_CONFLICT',
        '内容设置已变化，请刷新后重试。',
      );
    }
    const sourceIds = [
      ...new Set(input.recommended_companies.flatMap((company) => company.source_document_ids)),
    ];
    if (sourceIds.length > 0) {
      const sources = await transaction<{ id: string }[]>`
        SELECT id FROM source_documents WHERE tenant_id=${scope.tenantId}::uuid
          AND workspace_id=${before.workspace_id}::uuid AND id=ANY(${sourceIds}::uuid[])
          AND deleted_at IS NULL
          AND has_project_scope_access(tenant_id,workspace_id,project_id,${scope.userId}::uuid)
        FOR SHARE
      `;
      if (sources.length !== sourceIds.length) {
        throw new PlatformAccountError(
          'PLATFORM_ACCOUNT_NOT_FOUND',
          '部分资料不存在或无权访问，请在当前工作区选择资料。',
        );
      }
    }
    await transaction`
      INSERT INTO platform_account_content_policies (
        account_id,tenant_id,workspace_id,platform_code,default_style,
        recommended_companies_json,created_by,updated_by
      ) VALUES (
        ${accountId}::uuid,${scope.tenantId}::uuid,${before.workspace_id}::uuid,
        ${before.platform_code},${input.default_style},
        ${JSON.stringify(input.recommended_companies)}::text::jsonb,${scope.userId}::uuid,${scope.userId}::uuid
      ) ON CONFLICT (account_id) DO UPDATE SET
        default_style=EXCLUDED.default_style,recommended_companies_json=EXCLUDED.recommended_companies_json,
        updated_by=EXCLUDED.updated_by,version=platform_account_content_policies.version+1
    `;
    const after = await AccountContentPolicyService.getInTransaction(transaction, scope, accountId);
    await transaction`
      INSERT INTO audit_events (tenant_id,actor_id,action,resource_type,resource_id,before_json,after_json,ip,request_id)
      VALUES (${scope.tenantId}::uuid,${scope.userId}::uuid,'account.content_policy.updated',
        'platform_account',${accountId}::uuid,${JSON.stringify(before)}::text::jsonb,
        ${JSON.stringify(after)}::text::jsonb,${audit.ip ?? null},${audit.requestId})
    `;
    return after;
  }

  public static async getInTransaction(
    transaction: TransactionSql,
    scope: PlatformAccountScope,
    accountId: string,
  ): Promise<AccountContentPolicyView> {
    // Lock the account too: two first-time writes must not both observe version zero.
    const accounts = await transaction<
      { id: string; platform_code: string; workspace_id: string }[]
    >`
      SELECT id,platform_code,workspace_id FROM platform_accounts
      WHERE id=${accountId}::uuid AND tenant_id=${scope.tenantId}::uuid AND deleted_at IS NULL
        AND has_project_scope_access(tenant_id,workspace_id,NULL,${scope.userId}::uuid)
      FOR UPDATE
    `;
    const account = accounts[0];
    if (!account)
      throw new PlatformAccountError('PLATFORM_ACCOUNT_NOT_FOUND', '账号不存在或无权访问。');
    if (!supportsEditorialStyle(account.platform_code)) {
      throw new PlatformAccountError(
        'PLATFORM_ACCOUNT_STATE_INVALID',
        '本版内容风格仅支持官网、列举网、抖音。',
      );
    }
    const rows = await transaction<
      { default_style: string; recommended_companies: unknown; version: number }[]
    >`
      SELECT default_style,recommended_companies_json AS recommended_companies,version
      FROM platform_account_content_policies WHERE tenant_id=${scope.tenantId}::uuid AND account_id=${accountId}::uuid
    `;
    return AccountContentPolicyViewSchema.parse({
      account_id: accountId,
      platform_code: account.platform_code,
      workspace_id: account.workspace_id,
      default_style: rows[0]?.default_style ?? 'standard',
      recommended_companies: rows[0]?.recommended_companies ?? [],
      version: rows[0]?.version ?? 0,
    });
  }
}
