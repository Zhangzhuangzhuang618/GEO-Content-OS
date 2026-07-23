import type { BriefView } from '@geo-content-os/contracts';
import { describe, expect, it } from 'vitest';

import { BriefCostEstimator } from './brief-cost-estimator.js';

const UUIDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000007',
] as const;
const FROZEN_WEIGHTED_TOKEN_COST = 29_498;
const MAXIMUM_COST_REGRESSION = 1.15;

describe('BriefCostEstimator release cost gate', () => {
  it('keeps the fixed seven-platform workload within 15% of the frozen cost baseline', () => {
    const estimate = new BriefCostEstimator().estimate(fixedBrief());
    // The frozen rate card prices output tokens at twice the input-token rate.
    const weightedTokenCost =
      estimate.estimated_input_tokens + estimate.estimated_output_tokens * 2;

    expect(estimate.generation_request_count).toBe(2);
    expect(weightedTokenCost).toBeLessThanOrEqual(
      Math.floor(FROZEN_WEIGHTED_TOKEN_COST * MAXIMUM_COST_REGRESSION),
    );
  });
});

function fixedBrief(): BriefView {
  return {
    audience: '企业品牌、内容运营与合规审核团队',
    constraints: {
      additional_instructions: '仅使用已核验资料，不扩写事实。',
      cta: '预约企业演示',
      schema_version: 'brief-constraints@1',
    },
    created_at: '2026-07-15T00:00:00.000Z',
    created_by: UUIDS[0],
    due_at: null,
    id: UUIDS[1],
    keyword_ids: [UUIDS[2], UUIDS[3], UUIDS[4]],
    objective: 'trust',
    platform_codes: [
      'official_site',
      'baijiahao',
      'toutiao',
      'zhihu',
      'xiaohongshu',
      'wechat_mp',
      'douyin',
    ],
    primary_keyword_id: UUIDS[2],
    project_id: UUIDS[5],
    source_ids: [UUIDS[3], UUIDS[4]],
    source_topic_candidate_id: null,
    tenant_id: UUIDS[0],
    title: '七平台固定成本回归样本',
    updated_at: '2026-07-15T00:00:00.000Z',
    version: 1,
    workspace_id: UUIDS[6],
  };
}
