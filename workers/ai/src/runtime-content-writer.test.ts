import {
  MockModelAdapter,
  type ModelFinishReason,
  type ModelRequest,
  type ModelResult,
} from '@geo-content-os/adapter-model';
import { CONTENT_WRITER_CONTRACT_V1 } from '@geo-content-os/skills/content-writer';
import type postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import { readAiWorkerConfig } from './config.js';
import type { ContentWriterRunContext, JsonObject } from './generation.types.js';
import { RuntimeContentWriter } from './runtime-content-writer.js';
import { createRuntimeModels } from './runtime-model.js';

const MASTER_RUN = '70000000-0000-4000-8000-000000000061';
const VARIANT_RUN = '71000000-0000-4000-8000-000000000061';

describe('AI Worker runtime wiring', () => {
  it('runs Content Writer once and reuses its platform variants', async () => {
    const recordUsage = vi.fn();
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      createRuntimeModels('mock', {
        CONTENT_MODEL_BALANCED_KEY: 'deepseek-v4-flash',
      } as NodeJS.ProcessEnv),
      recordUsage,
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const masterContext = context(MASTER_RUN, null);
    const master = await writer.generateMaster({
      context: masterContext,
      requestId: 'runtime-content-master-0061',
      writerInput: fixture.input as JsonObject,
    });
    const variant = await writer.generateVariant({
      context: context(VARIANT_RUN, '72000000-0000-4000-8000-000000000061'),
      masterContent: master,
      platformCode: 'xiaohongshu',
      requestId: 'runtime-content-xiaohongshu-0061',
      writerInput: fixture.input as JsonObject,
    });

    expect(master.platform_code).toBe('master');
    expect(variant.platform_code).toBe('xiaohongshu');
    expect(recordUsage).toHaveBeenCalledOnce();
  });

  it('makes one fresh low-temperature attempt after structured output repair fails', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const recordUsage = vi.fn();
    const adapter = new LooseMockAdapter(
      [
        { text: '{"master_content":' },
        { text: '{"master_content":' },
        { text: JSON.stringify(fixture.output.data) },
      ],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      recordUsage,
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );

    await expect(
      writer.generateMaster({
        context: context(MASTER_RUN, null),
        requestId: 'runtime-content-structured-retry-0061',
        writerInput: fixture.input as JsonObject,
      }),
    ).resolves.toMatchObject({ platform_code: 'master' });
    expect(recordUsage).toHaveBeenCalledTimes(3);
  });

  it('generates official-site body and FAQ in separate shallow stages', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const article = officialSiteArticleDraft();
    const faq = {
      faq: Array.from({ length: 4 }, (_, index) => ({
        answer: `按照正文中的第 ${index + 1} 项核对方法执行，并保留双方确认记录。`,
        question: `第 ${index + 1} 项应该如何核对？`,
      })),
    };
    const adapter = new LooseMockAdapter(
      [{ text: JSON.stringify(article) }, { text: JSON.stringify(faq) }],
      'deepseek-v4-flash',
    );
    const recordUsage = vi.fn();
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      recordUsage,
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const writerInput = officialSiteWriterInput(fixture.input as JsonObject);
    const master = await writer.generateOfficialSiteMaster({
      context: context(MASTER_RUN, null),
      requestId: 'runtime-official-article-0061',
      writerInput,
    });
    const variant = await writer.generateOfficialSiteVariant({
      context: context(VARIANT_RUN, '72000000-0000-4000-8000-000000000061'),
      masterContent: master,
      platformCode: 'official_site',
      requestId: 'runtime-official-variant-0061',
      writerInput,
    });

    expect(master).toMatchObject({ platform_code: 'master', title: article.title });
    expect(variant).toMatchObject({
      platform_code: 'official_site',
      platform_meta: {
        faq: expect.arrayContaining([expect.objectContaining({ question: faq.faq[0]!.question })]),
        meta_description: article.summary,
        schema_org: { '@context': 'https://schema.org', '@type': 'Article' },
      },
    });
    expect((variant['platform_meta'] as { slug: string }).slug).toMatch(/^news-[a-f0-9]{16}$/u);
    expect(recordUsage).toHaveBeenCalledTimes(2);
  });

  it('keeps a short official-site article and appends substantive expansion blocks', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const shortArticle = officialSiteArticleDraft(4);
    const expansion = officialSiteExpansionDraft();
    const adapter = new LooseMockAdapter(
      [{ text: JSON.stringify(shortArticle) }, { text: JSON.stringify(expansion) }],
      'deepseek-v4-pro',
    );
    const recordUsage = vi.fn();
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-pro', adapter]]),
      recordUsage,
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );

    const generated = await writer.generateOfficialSiteMaster({
      context: {
        ...context(MASTER_RUN, null),
        modelKey: 'deepseek-v4-pro',
        modelPolicy: 'quality',
      },
      requestId: 'runtime-official-length-repair-0061',
      writerInput: officialSiteWriterInput(fixture.input as JsonObject),
    });

    expect(generated).toMatchObject({ platform_code: 'master', title: shortArticle.title });
    expect(generated.blocks.slice(0, shortArticle.blocks.length)).toEqual(
      shortArticle.blocks.map(({ block_key, block_type, text }) => ({
        block_key,
        block_type,
        text,
      })),
    );
    expect(
      generated.blocks
        .filter((block) => block.block_type !== 'heading')
        .map((block) => block.text)
        .join('')
        .replace(/[\s\p{P}\p{S}]/gu, '').length,
    ).toBeGreaterThanOrEqual(1_300);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0]!.messages.map((message) => message.content).join('\n')).toContain(
      'automatically rejected as perfunctory',
    );
    expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
      'This is a continuation stage',
    );
  });

  it('keeps the final direct-flow instruction in rewrite mode', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const article = officialSiteArticleDraft();
    const faq = {
      faq: Array.from({ length: 4 }, (_, index) => ({
        answer: `按照正文中的第 ${index + 1} 项核对方法执行，并保留双方确认记录。`,
        question: `第 ${index + 1} 项应该如何核对？`,
      })),
    };
    const adapter = new LooseMockAdapter(
      [
        { text: JSON.stringify(article) },
        { text: JSON.stringify(faq) },
        { text: JSON.stringify(article) },
        { text: JSON.stringify(faq) },
      ],
      'deepseek-v4-pro',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-pro', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const writerInput = officialSiteWriterInput(fixture.input as JsonObject);
    const rewriteContext = {
      ...context(VARIANT_RUN, '72000000-0000-4000-8000-000000000061'),
      modelKey: 'deepseek-v4-pro',
      modelPolicy: 'quality' as const,
    };
    const master = await writer.generateOfficialSiteMaster({
      context: rewriteContext,
      requestId: 'runtime-official-rewrite-master-0061',
      writerInput,
    });
    const variant = await writer.generateOfficialSiteVariant({
      context: rewriteContext,
      masterContent: master,
      platformCode: 'official_site',
      requestId: 'runtime-official-rewrite-variant-0061',
      writerInput,
    });

    await writer.rewriteOfficialSiteVariant({
      context: rewriteContext,
      currentContent: variant,
      issues: [
        '质量问题 BLOCK fact.high_risk.unsupported；位置：claim:scope-detail；修改建议：删除无证据事实',
      ],
      masterContent: master,
      requestId: 'runtime-official-rewrite-0061',
      writerInput,
    });

    const finalMessage = adapter.requests[2]!.messages.at(-1);
    expect(finalMessage?.content).toContain(
      'Rewrite the supplied official-site article completely',
    );
    expect(finalMessage?.content).toContain('specified block location');
  });

  it('forbids the Mock model in production', () => {
    expect(() =>
      readAiWorkerConfig({
        AI_MODEL_DRIVER: 'mock',
        DATABASE_URL: 'postgresql://local/test',
        NODE_ENV: 'production',
        REDIS_URL: 'redis://local',
      } as NodeJS.ProcessEnv),
    ).toThrow('forbidden in production');
  });

  it('returns plain text for an AI visibility probe in Mock mode', async () => {
    const models = createRuntimeModels('mock', {
      CONTENT_MODEL_BALANCED_KEY: 'deepseek-v4-flash',
      VISIBILITY_MODEL_KEY: 'deepseek-v4-flash',
    } as NodeJS.ProcessEnv);
    const result = await models.get('deepseek-v4-flash')!.generate({
      maxOutputTokens: 100,
      messages: [
        {
          content: JSON.stringify({ ai_visibility_query: { text: '如何选择搬家公司？' } }),
          role: 'user',
        },
      ],
      requestId: 'visibility-mock-0061',
      responseFormat: { type: 'text' },
    });
    expect(result.message.content).toBe('如何选择搬家公司？');
  });
});

function context(runId: string, variantId: string | null): ContentWriterRunContext {
  return Object.freeze({
    batchKey: 'a0000000-0000-4000-8000-000000000061',
    skillName: 'content-writer',
    inputHash: 'a'.repeat(64),
    modelKey: 'deepseek-v4-flash',
    modelPolicy: 'fast',
    packageId: '60000000-0000-4000-8000-000000000061',
    projectId: '40000000-0000-4000-8000-000000000061',
    promptVersionId: '80000000-0000-4000-8000-000000000061',
    runId,
    skillVersion: '1.0.0',
    tenantId: '90000000-0000-4000-8000-000000000061',
    variantId,
    workspaceId: '91000000-0000-4000-8000-000000000061',
  });
}

class LooseMockAdapter extends MockModelAdapter {
  public readonly requests: ModelRequest[] = [];
  private responseIndex = 0;

  public constructor(
    private readonly looseResponses: readonly {
      readonly finishReason?: ModelFinishReason;
      readonly text: string;
    }[],
    modelKey: string,
  ) {
    super({ modelKey });
  }

  public override async generate(input: ModelRequest): Promise<ModelResult> {
    this.requests.push(input);
    const base = await super.generate({ ...input, responseFormat: { type: 'text' } });
    const response = this.looseResponses[this.responseIndex] ?? { text: '' };
    this.responseIndex += 1;
    return Object.freeze({
      ...base,
      finishReason: response.finishReason ?? 'stop',
      message: Object.freeze({
        ...(response.text ? { content: response.text } : {}),
        role: 'assistant' as const,
      }),
    });
  }
}

function officialSiteWriterInput(input: JsonObject): JsonObject {
  const brief = input['brief'] as JsonObject;
  const rule = (input['platform_rules_by_code'] as JsonObject)['xiaohongshu'] as JsonObject;
  return {
    ...input,
    brief: {
      ...brief,
      constraints: { official_site_direct: true },
      platform_codes: ['official_site'],
      title: '广州家庭搬家前如何核对服务范围与执行人员安排',
    },
    platform_rules_by_code: { official_site: rule },
  };
}

function officialSiteArticleDraft(repeatCount = 12) {
  const paragraph = (label: string) =>
    `${label}时，应先把服务边界、人员安排、车辆计划、报价口径和异常处理方式分别确认，并将口头说明转化为可以复核的清单。`.repeat(
      repeatCount,
    );
  return {
    blocks: [
      {
        block_key: 'direct-answer',
        block_type: 'paragraph',
        citation_ids: [],
        text: paragraph('开始比较'),
      },
      {
        block_key: 'scope-heading',
        block_type: 'heading',
        citation_ids: [],
        text: '先确认服务范围',
      },
      {
        block_key: 'scope-detail',
        block_type: 'paragraph',
        citation_ids: [],
        text: paragraph('核对范围'),
      },
      {
        block_key: 'team-heading',
        block_type: 'heading',
        citation_ids: [],
        text: '再确认执行人员',
      },
      {
        block_key: 'checklist',
        block_type: 'list',
        citation_ids: [],
        text: paragraph('使用清单'),
      },
      {
        block_key: 'risk-heading',
        block_type: 'heading',
        citation_ids: [],
        text: '提前约定异常处理',
      },
      {
        block_key: 'risk-detail',
        block_type: 'paragraph',
        citation_ids: [],
        text: paragraph('处理异常'),
      },
      {
        block_key: 'conclusion',
        block_type: 'paragraph',
        citation_ids: [],
        text: '完成以上核对后，再根据实际需求选择服务方案，并保留双方确认记录。',
      },
    ],
    summary: '文章提供选择搬家服务时可直接执行的范围、人员、车辆和异常处理核对方法。',
    title: '广州家庭搬家前如何核对服务范围与执行人员安排',
  } as const;
}

function officialSiteExpansionDraft() {
  const text = (label: string) =>
    `${label}应结合实际物品、现场条件和双方约定逐项判断，说明核对方法、记录方式、责任边界与出现差异后的处理步骤。`.repeat(
      5,
    );
  return {
    blocks: [
      { block_type: 'paragraph', citation_ids: [], text: text('补充服务边界时') },
      { block_type: 'list', citation_ids: [], text: text('补充执行清单时') },
      { block_type: 'paragraph', citation_ids: [], text: text('补充风险处理时') },
    ],
  } as const;
}
