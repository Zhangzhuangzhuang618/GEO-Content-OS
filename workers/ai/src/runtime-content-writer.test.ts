import {
  MockModelAdapter,
  type ModelFinishReason,
  type ModelRequest,
  type ModelResult,
} from '@geo-content-os/adapter-model';
import type { ContentPlatformCode } from '@geo-content-os/contracts/skills';
import { CONTENT_WRITER_CONTRACT_V1 } from '@geo-content-os/skills/content-writer';
import type postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import { readAiWorkerConfig } from './config.js';
import type { ContentWriterRunContext, GeneratedContent, JsonObject } from './generation.types.js';
import { RuntimeContentWriter } from './runtime-content-writer.js';
import { createRuntimeModels } from './runtime-model.js';

const MASTER_RUN = '70000000-0000-4000-8000-000000000061';
const VARIANT_RUN = '71000000-0000-4000-8000-000000000061';
const GENERIC_PLATFORM_CASES = [
  ['baijiahao', 850],
  ['toutiao', 850],
  ['zhihu', 1_100],
  ['xiaohongshu', 500],
  ['wechat_mp', 1_300],
  ['douyin', 420],
] as const;

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

  it('retries an unchanged quality-guided rewrite with the original diagnostics', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const original = multiPlatformContentData(['baijiahao'], new Set());
    const originalVariant = original.variants[0]!;
    const rewritten = {
      ...original,
      variants: [
        {
          ...originalVariant,
          summary: '修订后直接说明搬家前需要核对的服务步骤、责任边界和风险处理方法。',
        },
      ],
    };
    const adapter = new LooseMockAdapter(
      [{ text: JSON.stringify(original) }, { text: JSON.stringify(rewritten) }],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const issue = '质量问题 BLOCK FORMAT_DIRECT_ANSWER；位置：intro；修改建议：首段直接回答';
    const writerInput = multiPlatformWriterInput(fixture.input as JsonObject, ['baijiahao']);

    const rewriteContext = context(MASTER_RUN, null);
    const master = await writer.generateMaster({
      context: rewriteContext,
      requestId: 'runtime-quality-rewrite-0061',
      revision: {
        candidate: {
          master_content: {
            ...original.master_content,
            schema_version: 'content-writer-data@1',
          } as unknown as GeneratedContent,
          variants: [
            {
              ...originalVariant,
              schema_version: 'content-writer-data@1',
            } as unknown as GeneratedContent,
          ],
        },
        contentVersionId: '82000000-0000-4000-8000-000000000061',
        issues: [issue],
        qualityReportId: '83000000-0000-4000-8000-000000000061',
      },
      writerInput,
    });
    const variant = await writer.generateVariant({
      context: { ...rewriteContext, runId: VARIANT_RUN },
      masterContent: master,
      platformCode: 'baijiahao',
      requestId: 'runtime-quality-rewrite-variant-0061',
      writerInput,
    });

    expect(adapter.requests[0]?.messages.map((message) => message.content).join('\n')).toContain(
      issue,
    );
    const retryPrompt = adapter.requests[1]?.messages.map((message) => message.content).join('\n');
    expect(retryPrompt).toContain(issue);
    expect(retryPrompt).toContain('质量报告驱动重写结果与待修改版本完全相同');
    expect(variant.summary).toBe(rewritten.variants[0]!.summary);
  });

  it('fails before persistence when a quality-guided rewrite remains unchanged', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const original = multiPlatformContentData(['baijiahao'], new Set());
    const originalVariant = original.variants[0]!;
    const adapter = new LooseMockAdapter(
      [{ text: JSON.stringify(original) }, { text: JSON.stringify(original) }],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );

    await expect(
      writer.generateMaster({
        context: context(MASTER_RUN, null),
        requestId: 'runtime-unchanged-quality-rewrite-0061',
        revision: {
          candidate: {
            master_content: {
              ...original.master_content,
              schema_version: 'content-writer-data@1',
            } as unknown as GeneratedContent,
            variants: [
              {
                ...originalVariant,
                schema_version: 'content-writer-data@1',
              } as unknown as GeneratedContent,
            ],
          },
          contentVersionId: '82000000-0000-4000-8000-000000000061',
          issues: ['质量问题 BLOCK fact.unsupported；修改建议：删除无证据事实'],
          qualityReportId: '83000000-0000-4000-8000-000000000061',
        },
        writerInput: multiPlatformWriterInput(fixture.input as JsonObject, ['baijiahao']),
      }),
    ).rejects.toMatchObject({
      code: 'CONTENT_QUALITY_INSUFFICIENT',
      message: expect.stringContaining('质量报告驱动重写结果与待修改版本完全相同'),
    });
  });

  it('removes Baijiahao CTA and then expands the final allowed body above the frozen minimum', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const repaired = multiPlatformContentData(['baijiahao'], new Set(['baijiahao']), true);
    const original = repaired.variants[0]!;
    const withCta = {
      ...repaired,
      variants: [
        {
          ...original,
          blocks: [
            ...original.blocks,
            { block_key: 'cta', block_type: 'cta' as const, text: '立即联系我们获取服务方案' },
          ],
          cta: '立即联系我们获取服务方案',
        },
      ],
    };
    const adapter = new LooseMockAdapter(
      [
        { text: JSON.stringify(withCta) },
        { text: JSON.stringify(repaired) },
        { text: JSON.stringify(platformExpansionDraft()) },
      ],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const writerInput = multiPlatformWriterInput(fixture.input as JsonObject, ['baijiahao']);
    const rewriteContext = {
      ...context(MASTER_RUN, null),
      modelPolicy: 'balanced' as const,
    };
    const master = await writer.generateMaster({
      context: rewriteContext,
      requestId: 'runtime-baijiahao-combined-rewrite-0061',
      revision: {
        candidate: {
          master_content: {
            ...repaired.master_content,
            schema_version: 'content-writer-data@1',
          } as unknown as GeneratedContent,
          variants: [
            {
              ...original,
              schema_version: 'content-writer-data@1',
            } as unknown as GeneratedContent,
          ],
        },
        contentVersionId: '82000000-0000-4000-8000-000000000061',
        issues: [
          '质量问题 BLOCK format.minimum_length；正文未达到 850 个有效字符',
          '质量问题 BLOCK compliance.cta；删除 CTA 字段和 CTA 内容块',
        ],
        qualityReportId: '83000000-0000-4000-8000-000000000061',
      },
      writerInput,
    });
    const variant = await writer.generateVariant({
      context: { ...rewriteContext, runId: VARIANT_RUN },
      masterContent: master,
      platformCode: 'baijiahao',
      requestId: 'runtime-baijiahao-combined-rewrite-variant-0061',
      writerInput,
    });

    expect(variant.cta).toBeNull();
    expect(variant.blocks.every((block) => block.block_type !== 'cta')).toBe(true);
    expect(readableContentCharacters(variant)).toBeGreaterThanOrEqual(850);
    expect(adapter.requests).toHaveLength(3);
    expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
      '不得包含 CTA 字段或 CTA 内容块',
    );
    expect(adapter.requests[2]!.messages.map((message) => message.content).join('\n')).toContain(
      'must contain at least 850',
    );
  });

  it.each(GENERIC_PLATFORM_CASES)(
    'uses the full %s platform length threshold during a balanced quality-report rewrite',
    async (platformCode, minimumCharacters) => {
      const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
      const data = multiPlatformContentData([platformCode], new Set([platformCode]), true);
      const adapter = new LooseMockAdapter(
        [{ text: JSON.stringify(data) }, { text: JSON.stringify(platformExpansionDraft()) }],
        'deepseek-v4-flash',
      );
      const writer = new RuntimeContentWriter(
        {} as postgres.Sql,
        new Map([['deepseek-v4-flash', adapter]]),
        vi.fn(),
        async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
      );
      const writerInput = multiPlatformWriterInput(fixture.input as JsonObject, [platformCode]);
      const rewriteContext = {
        ...context(MASTER_RUN, null),
        modelPolicy: 'balanced' as const,
      };
      const master = await writer.generateMaster({
        context: rewriteContext,
        requestId: `runtime-${platformCode}-balanced-rewrite-0061`,
        revision: {
          candidate: {
            master_content: {
              ...data.master_content,
              schema_version: 'content-writer-data@1',
            } as unknown as GeneratedContent,
            variants: data.variants.map(
              (variant) =>
                ({
                  ...variant,
                  schema_version: 'content-writer-data@1',
                }) as unknown as GeneratedContent,
            ),
          },
          contentVersionId: '82000000-0000-4000-8000-000000000061',
          issues: [
            `质量问题 BLOCK format.minimum_length；正文未达到 ${minimumCharacters} 个有效字符`,
          ],
          qualityReportId: '83000000-0000-4000-8000-000000000061',
        },
        writerInput,
      });
      const variant = await writer.generateVariant({
        context: { ...rewriteContext, runId: VARIANT_RUN },
        masterContent: master,
        platformCode,
        requestId: `runtime-${platformCode}-balanced-rewrite-variant-0061`,
        writerInput,
      });

      expect(readableContentCharacters(variant)).toBeGreaterThanOrEqual(minimumCharacters);
      expect(adapter.requests).toHaveLength(2);
      expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
        `must contain at least ${minimumCharacters}`,
      );
    },
  );

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
    const articlePrompt = adapter.requests[0]!.messages.map((message) => message.content).join(
      '\n',
    );
    expect(articlePrompt).toContain('广州志远搬家服务有限公司');
    expect(articlePrompt).toContain('某公司');
  });

  it('rewrites an official-site draft that names another company', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const cleanArticle = officialSiteArticleDraft();
    const forbiddenArticle = {
      ...cleanArticle,
      blocks: cleanArticle.blocks.map((block, index) =>
        index === 0
          ? { ...block, text: `广州家盛搬家有限公司可作为比较对象。${block.text}` }
          : block,
      ),
    };
    const adapter = new LooseMockAdapter(
      [{ text: JSON.stringify(forbiddenArticle) }, { text: JSON.stringify(cleanArticle) }],
      'deepseek-v4-pro',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-pro', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );

    const generated = await writer.generateOfficialSiteMaster({
      context: {
        ...context(MASTER_RUN, null),
        modelKey: 'deepseek-v4-pro',
        modelPolicy: 'quality',
      },
      requestId: 'runtime-official-company-policy-0061',
      writerInput: officialSiteWriterInput(fixture.input as JsonObject),
    });

    expect(JSON.stringify(generated)).not.toContain('广州家盛搬家有限公司');
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
      '禁止出现其他企业或品牌名称',
    );
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

  it.each(GENERIC_PLATFORM_CASES)(
    'keeps a short %s version and appends targeted expansion blocks',
    async (platformCode, minimumCharacters) => {
      const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
      const data = multiPlatformContentData([platformCode], new Set([platformCode]));
      const original = data.variants[0]!;
      const adapter = new LooseMockAdapter(
        [{ text: JSON.stringify(data) }, { text: JSON.stringify(platformExpansionDraft()) }],
        'deepseek-v4-pro',
      );
      const recordUsage = vi.fn();
      const writer = new RuntimeContentWriter(
        {} as postgres.Sql,
        new Map([['deepseek-v4-pro', adapter]]),
        recordUsage,
        async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
      );
      const writerInput = multiPlatformWriterInput(fixture.input as JsonObject, [platformCode]);
      const qualityContext = {
        ...context(MASTER_RUN, null),
        modelKey: 'deepseek-v4-pro',
        modelPolicy: 'quality' as const,
      };
      const master = await writer.generateMaster({
        context: qualityContext,
        requestId: `runtime-${platformCode}-length-repair-0061`,
        writerInput,
      });
      const variant = await writer.generateVariant({
        context: {
          ...qualityContext,
          runId: VARIANT_RUN,
          variantId: '72000000-0000-4000-8000-000000000061',
        },
        masterContent: master,
        platformCode,
        requestId: `runtime-${platformCode}-variant-0061`,
        writerInput,
      });

      expect(variant.blocks.slice(0, original.blocks.length)).toEqual(original.blocks);
      expect(readableContentCharacters(variant)).toBeGreaterThanOrEqual(minimumCharacters);
      expect(variant.blocks.length).toBeGreaterThan(original.blocks.length);
      expect(adapter.requests).toHaveLength(2);
      expect(recordUsage).toHaveBeenCalledTimes(2);
      const expansionPrompt = adapter.requests[1]!.messages.map((message) => message.content).join(
        '\n',
      );
      expect(expansionPrompt).toContain(`The ${platformCode} version currently has`);
      expect(expansionPrompt).toContain('required_new_effective_characters');
    },
  );

  it.each(GENERIC_PLATFORM_CASES)(
    'does not block a single %s generation on the hidden master length target',
    async (platformCode) => {
      const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
      const data = multiPlatformContentData([platformCode], new Set(), true);
      const adapter = new LooseMockAdapter([{ text: JSON.stringify(data) }], 'deepseek-v4-pro');
      const writer = new RuntimeContentWriter(
        {} as postgres.Sql,
        new Map([['deepseek-v4-pro', adapter]]),
        vi.fn(),
        async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
      );
      const writerInput = multiPlatformWriterInput(fixture.input as JsonObject, [platformCode]);
      const qualityContext = {
        ...context(MASTER_RUN, null),
        modelKey: 'deepseek-v4-pro',
        modelPolicy: 'quality' as const,
      };
      const master = await writer.generateMaster({
        context: qualityContext,
        requestId: `runtime-${platformCode}-hidden-master-0061`,
        writerInput,
      });
      const variant = await writer.generateVariant({
        context: { ...qualityContext, runId: VARIANT_RUN },
        masterContent: master,
        platformCode,
        requestId: `runtime-${platformCode}-hidden-master-variant-0061`,
        writerInput,
      });

      expect(readableContentCharacters(master)).toBeLessThan(1_300);
      expect(variant.platform_code).toBe(platformCode);
      expect(adapter.requests).toHaveLength(1);
    },
  );

  it('does not overwrite qualified variants while expanding another platform', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const platforms = ['baijiahao', 'xiaohongshu'] as const;
    const data = multiPlatformContentData(
      platforms,
      new Set<ContentPlatformCode>(['baijiahao']),
      true,
    );
    const qualifiedXiaohongshu = data.variants[1]!;
    const adapter = new LooseMockAdapter(
      [{ text: JSON.stringify(data) }, { text: JSON.stringify(platformExpansionDraft()) }],
      'deepseek-v4-pro',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-pro', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const writerInput = multiPlatformWriterInput(fixture.input as JsonObject, platforms);
    const qualityContext = {
      ...context(MASTER_RUN, null),
      modelKey: 'deepseek-v4-pro',
      modelPolicy: 'quality' as const,
    };
    const master = await writer.generateMaster({
      context: qualityContext,
      requestId: 'runtime-multiplatform-length-repair-0061',
      writerInput,
    });
    const baijiahao = await writer.generateVariant({
      context: { ...qualityContext, runId: VARIANT_RUN },
      masterContent: master,
      platformCode: 'baijiahao',
      requestId: 'runtime-multiplatform-baijiahao-0061',
      writerInput,
    });
    const xiaohongshu = await writer.generateVariant({
      context: { ...qualityContext, runId: VARIANT_RUN },
      masterContent: master,
      platformCode: 'xiaohongshu',
      requestId: 'runtime-multiplatform-xiaohongshu-0061',
      writerInput,
    });

    expect(readableContentCharacters(master)).toBeLessThan(1_300);
    expect(readableContentCharacters(baijiahao)).toBeGreaterThanOrEqual(850);
    expect(xiaohongshu).toMatchObject(qualifiedXiaohongshu);
    expect(adapter.requests).toHaveLength(2);
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

    await writer.generateOfficialSiteMaster({
      context: rewriteContext,
      requestId: 'runtime-official-rewrite-0061',
      revision: {
        candidate: { master_content: master, variants: [variant] },
        contentVersionId: '82000000-0000-4000-8000-000000000061',
        issues: [
          '质量问题 BLOCK fact.high_risk.unsupported；位置：claim:scope-detail；修改建议：删除无证据事实',
        ],
        qualityReportId: '83000000-0000-4000-8000-000000000061',
      },
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

function multiPlatformWriterInput(
  input: JsonObject,
  platformCodes: readonly ContentPlatformCode[],
): JsonObject {
  const brief = input['brief'] as JsonObject;
  const rule = (input['platform_rules_by_code'] as JsonObject)['xiaohongshu'] as JsonObject;
  return {
    ...input,
    brief: {
      ...brief,
      constraints: {},
      platform_codes: platformCodes,
      title: '搬家前如何核对服务细节',
    },
    citations: [],
    locked_blocks: [],
    platform_rules_by_code: Object.fromEntries(
      platformCodes.map((platformCode) => [platformCode, rule]),
    ),
  };
}

function multiPlatformContentData(
  platformCodes: readonly ContentPlatformCode[],
  shortPlatforms: ReadonlySet<ContentPlatformCode>,
  shortMaster = false,
) {
  return {
    master_content: platformContent('master', shortMaster),
    variants: platformCodes.map((platformCode) =>
      platformContent(platformCode, shortPlatforms.has(platformCode)),
    ),
  } as const;
}

function platformContent(platformCode: 'master' | ContentPlatformCode, short: boolean) {
  const structure = PLATFORM_STRUCTURES[platformCode];
  const blocks = Array.from({ length: structure.blocks }, (_, index) => {
    const blockType =
      index < structure.headings ? 'heading' : index === structure.headings ? 'list' : 'paragraph';
    const sentence =
      blockType === 'heading'
        ? `第${index + 1}步核对`
        : `第${index + 1}项应核对服务范围、现场条件、书面约定和异常处理步骤，并保留双方确认记录。`;
    return {
      block_key: `section-${index + 1}`,
      block_type: blockType,
      text: blockType === 'heading' || short ? sentence : sentence.repeat(12),
    } as const;
  });
  return {
    blocks,
    citation_map: [],
    cta: null,
    hashtags: [],
    platform_code: platformCode,
    platform_meta: {},
    summary: '文章说明搬家前可执行的服务核对步骤与风险边界。',
    title: '搬家前如何核对服务细节',
  } as const;
}

const PLATFORM_STRUCTURES = {
  master: { blocks: 8, headings: 3 },
  official_site: { blocks: 8, headings: 3 },
  baijiahao: { blocks: 7, headings: 2 },
  toutiao: { blocks: 7, headings: 2 },
  zhihu: { blocks: 8, headings: 3 },
  xiaohongshu: { blocks: 7, headings: 2 },
  wechat_mp: { blocks: 8, headings: 3 },
  douyin: { blocks: 8, headings: 2 },
} as const;

function platformExpansionDraft() {
  const text = (label: string) =>
    `${label}应结合实际物品、现场条件和双方书面约定逐项判断，说明核对方法、记录方式、责任边界与出现差异后的处理步骤。`.repeat(
      7,
    );
  return {
    blocks: Array.from({ length: 5 }, (_, index) => ({
      block_type: index === 1 ? ('list' as const) : ('paragraph' as const),
      citation_ids: [],
      text: text(`补充第${index + 1}项时`),
    })),
  } as const;
}

function readableContentCharacters(content: {
  readonly blocks: readonly { readonly text: string }[];
}) {
  return content.blocks
    .map((block) => block.text)
    .join('')
    .replace(/[\s\p{P}\p{S}]/gu, '').length;
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
