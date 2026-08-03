import type { ModelAdapter, ModelResult } from '@geo-content-os/adapter-model';
import { describe, expect, it, vi } from 'vitest';

import { ArticleImagePlanner } from './media-planner.js';

const SCOPE = Object.freeze({
  packageId: '60000000-0000-4000-8000-000000000061',
  projectId: '40000000-0000-4000-8000-000000000061',
  tenantId: '10000000-0000-4000-8000-000000000061',
  variantId: '70000000-0000-4000-8000-000000000061',
  workspaceId: '30000000-0000-4000-8000-000000000061',
});

describe('ArticleImagePlanner', () => {
  it('hardens a valid two-scene plan before Cloudflare generation', async () => {
    const recordUsage = vi.fn(async () => undefined);
    const planner = new ArticleImagePlanner(
      adapter({
        cover_label: '搬家验收指南',
        scenes: [
          {
            caption: '逐项清点物品示意',
            prompt: 'Editorial illustration of a family checking boxes in a clean home',
          },
          {
            caption: '复核费用项目示意',
            prompt: 'Editorial illustration of anonymous people reviewing a checklist indoors',
          },
        ],
      }),
      recordUsage,
    );

    const plan = await planner.plan(input('广州搬家公司推荐：搬家后如何验收？'));

    expect(plan.source).toBe('deepseek');
    expect(plan.scenes).toHaveLength(2);
    expect(plan.scenes[0].prompt).toContain('no identifiable company');
    expect(recordUsage).toHaveBeenCalledOnce();
  });

  it('falls back to anonymous templates when a model plan names another company', async () => {
    const planner = new ArticleImagePlanner(
      adapter({
        cover_label: '搬家指南',
        scenes: [
          {
            caption: '广州家盛搬家有限公司作业现场',
            prompt: 'Editorial illustration of a moving scene without text',
          },
          {
            caption: '清点物品示意',
            prompt: 'Editorial illustration of anonymous people checking boxes',
          },
        ],
      }),
      async () => undefined,
    );

    const plan = await planner.plan(input('广州家盛搬家有限公司服务介绍'));

    expect(plan.source).toBe('template');
    expect(JSON.stringify(plan)).not.toContain('广州家盛搬家有限公司');
    expect(plan.scenes[0].caption).toContain('某公司');
  });
});

function input(title: string) {
  return {
    content: { blocks: [{ block_type: 'heading', text: '验收步骤' }], summary: '实用流程', title },
    platformCode: 'official_site' as const,
    requestId: 'media-plan-test-1',
    scope: SCOPE,
  };
}

function adapter(output: Readonly<Record<string, unknown>>): ModelAdapter {
  return {
    capabilities: vi.fn(),
    estimate: vi.fn(),
    generate: vi.fn(
      async () =>
        ({
          message: { content: JSON.stringify(output), role: 'assistant' },
          usage: {
            durationMs: 10,
            inputTokens: 100,
            modelKey: 'deepseek-v4-flash',
            outputTokens: 50,
            providerCode: 'deepseek',
            providerModelId: 'deepseek-v4-flash',
            providerRequestId: 'request-1',
            totalTokens: 150,
          },
        }) as ModelResult,
    ),
    modelKey: 'deepseek-v4-flash',
    stream: vi.fn(),
  };
}
