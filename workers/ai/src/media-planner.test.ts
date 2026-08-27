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
    const model = adapter({
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
    });
    const planner = new ArticleImagePlanner(model, recordUsage);

    const plan = await planner.plan(input('广州搬家公司推荐：搬家后如何验收？'));

    expect(plan.source).toBe('deepseek');
    expect(plan.plannerFailure).toBeNull();
    expect(plan.scenes).toHaveLength(2);
    expect(plan.scenes[0].prompt).toContain('Flat vector editorial illustration');
    expect(plan.scenes[0].prompt).toContain('no identifiable company');
    expect(plan.plannerDiagnostics).toMatchObject({ attempts: 1, repaired: false });
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(model.generate).toHaveBeenCalledWith(
      expect.objectContaining({ responseFormat: { type: 'json_object' } }),
    );
    expect(vi.mocked(model.generate).mock.calls[0]?.[0].messages[0]?.content).toContain(
      '"cover_label"',
    );
    expect(vi.mocked(model.generate).mock.calls[0]?.[0].messages[0]?.content).toContain(
      'exactly two objects',
    );
  });

  it('repairs one structurally invalid response before falling back', async () => {
    const recordUsage = vi.fn(async () => undefined);
    const valid = {
      cover_label: '仓库搬迁指南',
      scenes: [
        {
          caption: '搬迁前物品盘点示意',
          prompt: 'Editorial illustration of anonymous workers checking generic boxes indoors',
        },
        {
          caption: '新场地路线核对示意',
          prompt: 'Editorial illustration of anonymous people reviewing a generic floor plan',
        },
      ],
    };
    const model = adapter({ image_plan: valid });
    vi.mocked(model.generate).mockResolvedValueOnce(modelResult({ image_plan: valid }, 'initial'));
    vi.mocked(model.generate).mockResolvedValueOnce(modelResult(valid, 'repair'));
    const planner = new ArticleImagePlanner(model, recordUsage);

    const plan = await planner.plan(input('仓库搬迁前需要做哪些准备？'));

    expect(plan.source).toBe('deepseek');
    expect(plan.plannerFailure).toBeNull();
    expect(plan.plannerDiagnostics).toMatchObject({
      attempts: 2,
      initialResponse: {
        failure: expect.stringContaining('Image plan shape is invalid'),
        sceneCount: null,
        topLevelKeys: ['image_plan'],
      },
      repairResponse: {
        failure: null,
        sceneCount: 2,
        topLevelKeys: ['cover_label', 'scenes'],
      },
      repaired: true,
    });
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(model.generate).mock.calls[1]?.[0]).toMatchObject({
      requestId: 'media-plan-test-1:repair',
      responseFormat: { type: 'json_object' },
      temperature: 0,
    });
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
    expect(plan.plannerFailure).toContain('Image scene violates the deterministic prompt gate');
    expect(JSON.stringify(plan)).not.toContain('广州家盛搬家有限公司');
    expect(plan.scenes[0].caption).toContain('某公司');
  });

  it('stores a bounded redacted response preview when repair also fails', async () => {
    const planner = new ArticleImagePlanner(
      adapter({
        image_plan: {
          note: `广州家盛搬家有限公司 token=planner-secret 13800138000 ${'甲'.repeat(2_100)}`,
        },
      }),
      async () => undefined,
    );

    const plan = await planner.plan(input('搬家准备指南'));
    const diagnostics = JSON.stringify(plan.plannerDiagnostics);

    expect(plan.source).toBe('template');
    expect(plan.plannerDiagnostics.attempts).toBe(2);
    expect(plan.plannerDiagnostics.initialResponse?.responsePreview.length).toBeLessThanOrEqual(
      2_000,
    );
    expect(diagnostics).toContain('某公司');
    expect(diagnostics).toContain('token=[REDACTED]');
    expect(diagnostics).toContain('[PHONE]');
    expect(diagnostics).not.toContain('广州家盛搬家有限公司');
    expect(diagnostics).not.toContain('planner-secret');
    expect(diagnostics).not.toContain('13800138000');
  });

  it('redacts model credentials from a persisted planner fallback diagnostic', async () => {
    const model = adapter({});
    vi.mocked(model.generate).mockRejectedValueOnce(
      Object.assign(new Error('request failed api_key=planner-secret'), {
        code: 'UPSTREAM_FAILED',
      }),
    );
    const planner = new ArticleImagePlanner(model, async () => undefined);

    const plan = await planner.plan(input('搬家准备指南'));

    expect(plan.source).toBe('template');
    expect(plan.plannerFailure).toContain('code=UPSTREAM_FAILED');
    expect(plan.plannerFailure).toContain('api_key=[REDACTED]');
    expect(plan.plannerFailure).not.toContain('planner-secret');
  });

  it('plans a bounded set of distinct Douyin card backgrounds', async () => {
    const recordUsage = vi.fn(async () => undefined);
    const model = adapter({
      visuals: [
        {
          caption: '跨区搬家车辆与住宅场景示意',
          card_key: 'cover',
          prompt:
            'A polished editorial illustration of a generic moving truck between two city neighborhoods',
        },
        {
          caption: '工作人员核对装卸条件示意',
          card_key: 'conditions',
          prompt:
            'Anonymous movers checking a residential elevator and a clear loading path with boxes',
        },
        {
          caption: '物品分区清点示意',
          card_key: 'inventory',
          prompt: 'An organized editorial scene of anonymous people grouping generic boxes by room',
        },
      ],
    });
    const planner = new ArticleImagePlanner(model, recordUsage);

    const plan = await planner.planDouyin(douyinInput());

    expect(plan.source).toBe('deepseek');
    expect(plan.visuals).toHaveLength(3);
    expect(plan.visuals[0]).toMatchObject({ cardKey: 'cover' });
    expect(plan.visuals[0]?.prompt).toContain('vertical 3:4 composition');
    expect(plan.visuals[0]?.prompt).toContain('not documentary evidence');
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(vi.mocked(model.generate).mock.calls[0]?.[0]).toMatchObject({
      requestId: 'douyin-media-plan-test:douyin',
      responseFormat: { type: 'json_object' },
    });
  });

  it('falls back when a Douyin plan selects the summary card as a generated scene', async () => {
    const model = adapter({
      visuals: [
        {
          caption: '封面示意',
          card_key: 'cover',
          prompt: 'A generic editorial moving scene with anonymous people and unbranded boxes',
        },
        {
          caption: '条件核对示意',
          card_key: 'conditions',
          prompt: 'Anonymous people checking a generic loading route in an editorial illustration',
        },
        {
          caption: '总结示意',
          card_key: 'summary',
          prompt: 'A generic summary scene with anonymous people and blank cards without text',
        },
      ],
    });
    const planner = new ArticleImagePlanner(model, async () => undefined);

    const plan = await planner.planDouyin(douyinInput());

    expect(plan.source).toBe('template');
    expect(plan.visuals).toEqual([]);
    expect(plan.plannerFailure).toContain('Douyin visual plan violates');
    expect(plan.plannerDiagnostics.attempts).toBe(2);
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

function douyinInput() {
  return {
    cards: [
      {
        body: '先看车辆、电梯和装卸时段。',
        cardKey: 'cover',
        heading: '跨区搬家怎么排',
        kind: 'cover' as const,
      },
      {
        body: '核对楼层、电梯预约和门口停车条件。',
        cardKey: 'conditions',
        heading: '先看装卸条件',
        kind: 'body' as const,
      },
      {
        body: '按房间分组并记录大件和易碎物品。',
        cardKey: 'inventory',
        heading: '物品先分区',
        kind: 'body' as const,
      },
      {
        body: '确认车型、到场时段和装载限制。',
        cardKey: 'vehicle',
        heading: '车辆这样核对',
        kind: 'body' as const,
      },
      {
        body: '临时加项和等待时间需要提前确认。',
        cardKey: 'risk',
        heading: '注意临时风险',
        kind: 'body' as const,
      },
      {
        body: '按条件、物品、车辆和风险逐项确认。',
        cardKey: 'summary',
        heading: '最后再核对',
        kind: 'summary' as const,
      },
    ],
    description: '跨区搬家需要先确认装卸条件，再安排车辆和物品顺序。',
    requestId: 'douyin-media-plan-test',
    scope: SCOPE,
    title: '跨区搬家当天怎么安排',
  };
}

function adapter(output: Readonly<Record<string, unknown>>): ModelAdapter {
  return {
    capabilities: vi.fn(),
    estimate: vi.fn(),
    generate: vi.fn(async () => modelResult(output, 'request-1')),
    modelKey: 'deepseek-v4-flash',
    stream: vi.fn(),
  };
}

function modelResult(output: Readonly<Record<string, unknown>>, requestId: string): ModelResult {
  return {
    message: { content: JSON.stringify(output), role: 'assistant' },
    usage: {
      durationMs: 10,
      inputTokens: 100,
      modelKey: 'deepseek-v4-flash',
      outputTokens: 50,
      providerCode: 'deepseek',
      providerModelId: 'deepseek-v4-flash',
      providerRequestId: requestId,
      totalTokens: 150,
    },
  } as ModelResult;
}
