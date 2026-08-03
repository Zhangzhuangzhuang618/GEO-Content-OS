import type { ModelUsage } from '@geo-content-os/adapter-model';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

export interface MediaUsageScope {
  readonly packageId: string;
  readonly projectId: string;
  readonly tenantId: string;
  readonly variantId: string;
  readonly workspaceId: string;
}

interface RateCard {
  readonly currency: string;
  readonly inputRateMicros: string;
  readonly outputRateMicros: string;
}

const MICROS_PER_CENT = 10_000n;
const TOKENS_PER_RATE_UNIT = 1_000_000n;

export class PostgresMediaUsageRecorder {
  public constructor(private readonly client: postgres.Sql) {}

  public async recordPlanner(scope: MediaUsageScope, usage: ModelUsage): Promise<void> {
    const rates = await this.client<RateCard[]>`
      SELECT currency,input_rate_micros::text AS "inputRateMicros",
        output_rate_micros::text AS "outputRateMicros"
      FROM model_rate_cards
      WHERE model_key=${usage.modelKey} AND provider=${usage.providerCode}
        AND provider_model_id=${usage.providerModelId}
        AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now())
      ORDER BY effective_from DESC LIMIT 1
    `;
    const rate = rates[0];
    const costCents = rate
      ? Number(
          divideCeiling(
            divideCeiling(
              BigInt(usage.inputTokens) * BigInt(rate.inputRateMicros) +
                BigInt(usage.outputTokens) * BigInt(rate.outputRateMicros),
              TOKENS_PER_RATE_UNIT,
            ),
            MICROS_PER_CENT,
          ),
        )
      : 0;
    await this.record(scope, {
      costCents,
      currency: rate?.currency ?? 'CNY',
      modelKey: usage.modelKey,
      provider: usage.providerCode,
      quantity: usage.totalTokens,
      requestId: `media-plan:${hash(usage.providerRequestId)}`,
      skillName: 'image-planner',
      unit: 'token',
    });
  }

  private record(
    scope: MediaUsageScope,
    input: {
      readonly costCents: number;
      readonly currency: string;
      readonly modelKey: string;
      readonly provider: string;
      readonly quantity: number;
      readonly requestId: string;
      readonly skillName: string;
      readonly unit: 'request' | 'token';
    },
  ): Promise<void> {
    return this.client.begin(async (transaction) => {
      for (const status of ['estimated', 'settled'] as const) {
        await transaction`
          INSERT INTO usage_ledger (
            tenant_id,workspace_id,project_id,package_id,variant_id,request_id,
            cost_category,provider,model_key,skill_name,quantity,unit,
            cost_cents,currency,status
          ) VALUES (
            ${scope.tenantId}::uuid,${scope.workspaceId}::uuid,${scope.projectId}::uuid,
            ${scope.packageId}::uuid,${scope.variantId}::uuid,${input.requestId},
            'llm',${input.provider},${input.modelKey},${input.skillName},${input.quantity},
            ${input.unit},${input.costCents},${input.currency},${status}
          )
          ON CONFLICT DO NOTHING
        `;
      }
    });
  }
}

function divideCeiling(value: bigint, divisor: bigint): bigint {
  return value === 0n ? 0n : (value + divisor - 1n) / divisor;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 64);
}
