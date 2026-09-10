import { EditorialContextSchema } from '@geo-content-os/contracts';
import { loadRecommendationEvidence } from '@geo-content-os/retrieval';
import type postgres from 'postgres';

export async function dailyEditorialContext(
  transaction: postgres.TransactionSql,
  batch: {
    tenantId: string;
    workspaceId: string;
    projectId: string;
    createdBy: string;
    accountId: string;
    editorialContext: unknown;
  },
  platform: string,
) {
  if (platform === 'sohu' || !batch.editorialContext) return { context: null, citations: [] };
  const context = EditorialContextSchema.parse(batch.editorialContext);
  if (context.platform_code !== platform || context.account_id !== batch.accountId) {
    throw new Error('日批冻结的内容设置与目标账号不匹配');
  }
  const citations = await loadRecommendationEvidence(
    transaction,
    { ...batch, userId: batch.createdBy },
    context.companies,
  );
  return {
    context,
    citations,
  };
}
