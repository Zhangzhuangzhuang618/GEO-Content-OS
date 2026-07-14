import type { BriefView, PlatformCode } from '@geo-content-os/contracts';
import { Injectable } from '@nestjs/common';

const PLATFORM_OUTPUT_TOKEN_BUDGET = Object.freeze({
  baijiahao: 1_600,
  douyin: 900,
  official_site: 2_400,
  toutiao: 1_800,
  wechat_mp: 2_000,
  xiaohongshu: 1_000,
  zhihu: 2_200,
} satisfies Readonly<Record<PlatformCode, number>>);

export interface BriefCostEstimateInput {
  readonly estimated_input_tokens: number;
  readonly estimated_output_tokens: number;
  readonly generation_request_count: number;
  readonly platform_codes: readonly PlatformCode[];
  readonly pricing_status: 'requires_model_router';
  readonly schema_version: 'brief-cost-estimate-input@1';
}

/**
 * Produces the stable workload estimate consumed by the later model router. Monetary rates are
 * deliberately not duplicated here; the versioned rate card remains the sole pricing authority.
 */
@Injectable()
export class BriefCostEstimator {
  public estimate(brief: BriefView): BriefCostEstimateInput {
    const constraintCharacters = JSON.stringify(brief.constraints).length;
    const estimatedInputTokens = Math.ceil(
      800 +
        brief.audience.length / 2 +
        constraintCharacters / 2 +
        brief.keyword_ids.length * 80 +
        brief.source_ids.length * 500,
    );
    const estimatedOutputTokens =
      1_800 +
      brief.platform_codes.reduce(
        (total, platformCode) => total + PLATFORM_OUTPUT_TOKEN_BUDGET[platformCode],
        0,
      );
    return Object.freeze({
      estimated_input_tokens: estimatedInputTokens,
      estimated_output_tokens: estimatedOutputTokens,
      generation_request_count: 1 + brief.platform_codes.length,
      platform_codes: Object.freeze([...brief.platform_codes]),
      pricing_status: 'requires_model_router',
      schema_version: 'brief-cost-estimate-input@1',
    });
  }
}
