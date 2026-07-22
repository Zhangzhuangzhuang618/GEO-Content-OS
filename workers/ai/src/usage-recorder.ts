import type { ModelUsage } from '@geo-content-os/adapter-model';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

export interface UsageContext {
  readonly packageId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly skillName: 'content-writer' | 'quality-checker';
  readonly tenantId: string;
  readonly variantId: string | null;
  readonly workspaceId: string;
}

interface RateCard {
  readonly currency: string;
  readonly inputRateMicros: string;
  readonly outputRateMicros: string;
}

const MICROS_PER_CENT = 10_000n;
const TOKENS_PER_RATE_UNIT = 1_000_000n;

export class PostgresUsageRecorder {
  public constructor(private readonly client: postgres.Sql) {}

  public async record(context: UsageContext, usage: ModelUsage): Promise<void> {
    const rows = await this.client<RateCard[]>`
      SELECT
        currency,
        input_rate_micros::text AS "inputRateMicros",
        output_rate_micros::text AS "outputRateMicros"
      FROM model_rate_cards
      WHERE
        model_key = ${usage.modelKey}
        AND provider = ${usage.providerCode}
        AND provider_model_id = ${usage.providerModelId}
        AND effective_from <= now()
        AND (effective_to IS NULL OR effective_to > now())
      ORDER BY effective_from DESC
      LIMIT 1
    `;
    const rate = rows[0];
    const costCents = rate ? calculateCostCents(usage, rate) : 0;
    const currency = rate?.currency ?? 'CNY';
    const requestId = usageRequestId(usage.providerRequestId);
    await this.client.begin(async (transaction) => {
      await insertUsage(transaction, context, usage, requestId, costCents, currency, 'estimated');
      await insertUsage(transaction, context, usage, requestId, costCents, currency, 'settled');
    });
  }
}

async function insertUsage(
  transaction: postgres.TransactionSql,
  context: UsageContext,
  usage: ModelUsage,
  requestId: string,
  costCents: number,
  currency: string,
  status: 'estimated' | 'settled',
): Promise<void> {
  await transaction`
    INSERT INTO usage_ledger (
      tenant_id, workspace_id, project_id, package_id, variant_id, generation_run_id,
      request_id, cost_category, provider, model_key, skill_name, quantity, unit,
      input_tokens, output_tokens, cost_cents, currency, status
    ) VALUES (
      ${context.tenantId}::uuid,
      ${context.workspaceId}::uuid,
      ${context.projectId}::uuid,
      ${context.packageId}::uuid,
      ${context.variantId}::uuid,
      ${context.runId}::uuid,
      ${requestId},
      'llm',
      ${usage.providerCode},
      ${usage.modelKey},
      ${context.skillName},
      ${usage.totalTokens},
      'token',
      ${usage.inputTokens},
      ${usage.outputTokens},
      ${costCents},
      ${currency},
      ${status}
    )
    ON CONFLICT DO NOTHING
  `;
}

function calculateCostCents(usage: ModelUsage, rate: RateCard): number {
  const micros = divideCeiling(
    BigInt(usage.inputTokens) * BigInt(rate.inputRateMicros) +
      BigInt(usage.outputTokens) * BigInt(rate.outputRateMicros),
    TOKENS_PER_RATE_UNIT,
  );
  return Number(divideCeiling(micros, MICROS_PER_CENT));
}

function divideCeiling(value: bigint, divisor: bigint): bigint {
  return value === 0n ? 0n : (value + divisor - 1n) / divisor;
}

function usageRequestId(providerRequestId: string): string {
  return `ai:${createHash('sha256').update(providerRequestId).digest('hex')}`;
}
