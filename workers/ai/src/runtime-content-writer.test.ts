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

  it('removes an identical Douyin CTA block while preserving the canonical CTA', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const output = multiPlatformContentData(['douyin'], new Set());
    const cta = '保存清单后，再逐项核对。';
    const variant = output.variants[0]!;
    const adapter = new LooseMockAdapter(
      [
        {
          text: JSON.stringify({
            ...output,
            variants: [
              {
                ...variant,
                blocks: [...variant.blocks, { block_key: 'cta', block_type: 'cta', text: cta }],
                cta,
              },
            ],
          }),
        },
      ],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const writerInput = multiPlatformWriterInput(fixture.input as JsonObject, ['douyin']);
    const masterContext = context(MASTER_RUN, null);
    const master = await writer.generateMaster({
      context: masterContext,
      requestId: 'runtime-douyin-cta-master-0061',
      writerInput,
    });
    const generatedVariant = await writer.generateVariant({
      context: { ...masterContext, runId: VARIANT_RUN },
      masterContent: master,
      platformCode: 'douyin',
      requestId: 'runtime-douyin-cta-variant-0061',
      writerInput,
    });

    expect(generatedVariant.cta).toBe(cta);
    expect(generatedVariant.blocks.some((block) => block.block_type === 'cta')).toBe(false);
  });

  it('does not let fast mode bypass the Douyin narrative caption gate', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const repaired = multiPlatformContentData(['douyin'], new Set());
    const initial = {
      ...repaired,
      variants: [
        {
          ...repaired.variants[0]!,
          platform_meta: {
            ...repaired.variants[0]!.platform_meta,
            description: '搬家当天少等待，需要提前核对现场条件、物品清单和时间安排。',
          },
        },
      ],
    };
    const adapter = new LooseMockAdapter(
      [{ text: JSON.stringify(initial) }, { text: JSON.stringify(repaired) }],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const writerInput = multiPlatformWriterInput(fixture.input as JsonObject, ['douyin']);
    const masterContext = context(MASTER_RUN, null);
    const master = await writer.generateMaster({
      context: masterContext,
      requestId: 'runtime-douyin-fast-caption-master-0061',
      writerInput,
    });
    const variant = await writer.generateVariant({
      context: { ...masterContext, runId: VARIANT_RUN },
      masterContent: master,
      platformCode: 'douyin',
      requestId: 'runtime-douyin-fast-caption-variant-0061',
      writerInput,
    });

    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
      '/variants/0/platform_meta/description',
    );
    expect((variant.platform_meta as JsonObject)['description']).toBe(DOUYIN_NARRATIVE_DESCRIPTION);
  });

  it('allows up to three report-guided Douyin rewrites before rejecting generation', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const repaired = multiPlatformContentData(['douyin'], new Set());
    const repairedPlatformMeta = repaired.variants[0]!.platform_meta as JsonObject;
    const invalidDescription = DOUYIN_NARRATIVE_DESCRIPTION.replace(/\n+/gu, '');
    const invalid = {
      ...repaired,
      variants: [
        {
          ...repaired.variants[0]!,
          platform_meta: {
            ...repairedPlatformMeta,
            cards: (repairedPlatformMeta['cards'] as readonly JsonObject[]).map((card, index) =>
              index === 0 ? { ...card, heading: '工厂搬迁准备' } : card,
            ),
            description: invalidDescription,
          },
        },
      ],
    };
    const stillInvalid = {
      ...invalid,
      variants: [{ ...invalid.variants[0]!, summary: '第二次修订仍未完成段落与封面要求。' }],
    };
    const adapter = new LooseMockAdapter(
      [
        { text: JSON.stringify(invalid) },
        { text: JSON.stringify(stillInvalid) },
        { text: JSON.stringify(repaired) },
      ],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const writerInput = multiPlatformWriterInput(fixture.input as JsonObject, ['douyin']);
    const masterContext = context(MASTER_RUN, null);
    const master = await writer.generateMaster({
      context: masterContext,
      requestId: 'runtime-douyin-three-rewrites-master-0061',
      writerInput,
    });
    const variant = await writer.generateVariant({
      context: { ...masterContext, runId: VARIANT_RUN },
      masterContent: master,
      platformCode: 'douyin',
      requestId: 'runtime-douyin-three-rewrites-variant-0061',
      writerInput,
    });

    expect(adapter.requests).toHaveLength(3);
    expect((variant.platform_meta as JsonObject)['description']).toBe(DOUYIN_NARRATIVE_DESCRIPTION);
  });

  it('places the published owner company naturally in the solution paragraphs', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const initial = multiPlatformContentData(['douyin'], new Set());
    const ownerCompanyName = '广州志远搬家服务有限公司';
    const repairedDescription = DOUYIN_NARRATIVE_DESCRIPTION.replace(
      '确定方案前应核对',
      `${ownerCompanyName}可先协助核对`,
    );
    const repaired = {
      ...initial,
      variants: [
        {
          ...initial.variants[0]!,
          platform_meta: {
            ...initial.variants[0]!.platform_meta,
            description: repairedDescription,
          },
        },
      ],
    };
    const adapter = new LooseMockAdapter(
      [{ text: JSON.stringify(initial) }, { text: JSON.stringify(repaired) }],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const baseInput = multiPlatformWriterInput(fixture.input as JsonObject, ['douyin']);
    const strategy = baseInput['strategy'] as JsonObject;
    const writerInput = {
      ...baseInput,
      strategy: {
        ...strategy,
        profile: {
          ...(strategy['profile'] as JsonObject),
          positioning: `${ownerCompanyName}面向广州提供搬迁服务。`,
        },
      },
    } as JsonObject;
    const masterContext = context(MASTER_RUN, null);
    const master = await writer.generateMaster({
      context: masterContext,
      requestId: 'runtime-douyin-owner-master-0061',
      writerInput,
    });
    const variant = await writer.generateVariant({
      context: { ...masterContext, runId: VARIANT_RUN },
      masterContent: master,
      platformCode: 'douyin',
      requestId: 'runtime-douyin-owner-variant-0061',
      writerInput,
    });

    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
      '第二或第三段必须自然提及一次当前企业名称',
    );
    expect((variant.platform_meta as JsonObject)['description']).toContain(ownerCompanyName);
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
    const revisionMessage = adapter.requests[0]?.messages.find((message) =>
      message.content?.includes('candidate_to_rewrite'),
    );
    if (!revisionMessage?.content) throw new Error('Revision prompt was not recorded');
    const revisionPayload = JSON.parse(revisionMessage.content) as {
      candidate_to_rewrite: {
        master_content: Record<string, unknown>;
        variants: readonly Record<string, unknown>[];
      };
    };
    expect(revisionPayload.candidate_to_rewrite.master_content).not.toHaveProperty(
      'schema_version',
    );
    expect(revisionPayload.candidate_to_rewrite.variants[0]).not.toHaveProperty('schema_version');
    expect(adapter.requests[0]?.messages.at(-1)?.content).toContain(
      'This is a quality-guided rewrite, not a new draft',
    );
    expect(adapter.requests[0]?.messages.at(-1)?.content).toContain('Do not emit schema_version');
    expect(adapter.requests[0]?.messages.at(-1)?.content).toContain('cta must be null');
    const retryPrompt = adapter.requests[1]?.messages.map((message) => message.content).join('\n');
    expect(retryPrompt).toContain(issue);
    expect(retryPrompt).toContain('质量报告驱动重写结果与待修改版本完全相同');
    expect(adapter.requests.every((request) => !request.tools?.length)).toBe(true);
    expect(variant.summary).toBe(rewritten.variants[0]!.summary);
  });

  it('passes Lieju lexical blockers into the browser-platform rewrite prompt', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const repaired = multiPlatformContentData(['lieju'], new Set());
    const original = {
      ...repaired.variants[0]!,
      blocks: repaired.variants[0]!.blocks.map((block, index) =>
        index === repaired.variants[0]!.blocks.length - 1
          ? { ...block, text: `${block.text}不要轻信“百分百满意”等绝对化承诺。` }
          : block,
      ),
      schema_version: 'content-writer-data@1' as const,
    } as unknown as GeneratedContent;
    const adapter = new LooseMockAdapter([{ text: JSON.stringify(repaired) }], 'deepseek-v4-flash');
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const issue =
      'deterministic.lieju.prohibited_promotional_term | blocks.risk-warning | 列举网待发布内容包含发布层禁止的宣传词“百分百”。 | 删除原词并改为中性表达。';

    const rewritten = await writer.rewriteBrowserPlatformVariant({
      context: { ...context(MASTER_RUN, null), modelPolicy: 'quality' },
      currentContent: original,
      issues: [issue],
      platformCode: 'lieju',
      requestId: 'runtime-lieju-lexical-rewrite-0061',
      writerInput: multiPlatformWriterInput(fixture.input as JsonObject, ['lieju']),
    });

    const prompt = adapter.requests[0]?.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain(issue);
    expect(prompt).toContain('即使这些词出现在否定、引用或举例中');
    expect(rewritten.blocks.map((block) => block.text).join('\n')).not.toContain('百分百');
  });

  it('uses a targeted repair to remove a literal phone from Lieju content', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const clean = multiPlatformContentData(['lieju'], new Set());
    const variantBlockIndex = clean.variants[0]!.blocks.length - 1;
    const contactGuidance = '如需咨询可拨打02085627757，服务说明可访问www.example.com查看。';
    const unresolved = {
      ...clean,
      variants: [
        {
          ...clean.variants[0]!,
          blocks: clean.variants[0]!.blocks.map((block, index) =>
            index === variantBlockIndex
              ? { ...block, text: `${block.text}${contactGuidance}` }
              : block,
          ),
        },
      ],
    };
    const targetedRepair = {
      replacements: [
        {
          replacement_text: `${clean.variants[0]!.blocks[variantBlockIndex]!.text}如需咨询可通过页面联系方式说明需求，服务说明可访问www.example.com查看。`,
          target_id: `variants.lieju.blocks[${variantBlockIndex}].text`,
        },
      ],
    };
    const partiallyRepaired = {
      replacements: [
        {
          replacement_text: `${clean.variants[0]!.blocks[variantBlockIndex]!.text}如需进一步咨询可拨打02085627757，服务说明可访问www.example.com查看。`,
          target_id: `variants.lieju.blocks[${variantBlockIndex}].text`,
        },
      ],
    };
    const adapter = new LooseMockAdapter(
      [
        { text: JSON.stringify(unresolved) },
        { text: JSON.stringify(unresolved) },
        { text: JSON.stringify(partiallyRepaired) },
        { text: JSON.stringify(targetedRepair) },
      ],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );

    const rewritten = await writer.rewriteBrowserPlatformVariant({
      context: { ...context(MASTER_RUN, null), modelPolicy: 'quality' },
      currentContent: {
        ...unresolved.variants[0]!,
        schema_version: 'content-writer-data@1' as const,
      } as unknown as GeneratedContent,
      issues: [
        'deterministic.lieju.phone_forbidden | blocks.contact | 列举网待发布内容包含禁止的电话号码。 | 删除电话号码',
      ],
      platformCode: 'lieju',
      requestId: 'runtime-lieju-phone-targeted-repair-0070',
      writerInput: multiPlatformWriterInput(fixture.input as JsonObject, ['lieju']),
    });

    expect(adapter.requests).toHaveLength(4);
    const finalPrompt = adapter.requests[3]!.messages.map((message) => message.content).join('\n');
    expect(finalPrompt).toContain('prohibited_contact_details');
    expect(finalPrompt).toContain('02085627757');
    expect(finalPrompt).toContain('replacement_still_contains_prohibited_contact_detail');
    const rewrittenText = rewritten.blocks.map((block) => block.text).join('\n');
    expect(rewrittenText).toContain('通过页面联系方式说明需求');
    expect(rewrittenText).toContain('www.example.com');
    expect(rewrittenText).not.toContain('02085627757');
  });

  it('repairs a Lieju credential claim until it cites the supplied structured certificate', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const base = multiPlatformContentData(['lieju'], new Set());
    const variant = base.variants[0]!;
    const credentialText = '公司持有道路运输经营许可证。';
    const unsupported = {
      ...base,
      variants: [
        {
          ...variant,
          blocks: variant.blocks.map((block, index) =>
            index === variant.blocks.length - 1
              ? { ...block, text: `${block.text}${credentialText}` }
              : block,
          ),
        },
      ],
    };
    const citationId = '10000000-0000-4000-8000-000000000162';
    const sourceId = '20000000-0000-4000-8000-000000000162';
    const repaired = {
      ...unsupported,
      variants: [
        {
          ...unsupported.variants[0]!,
          citation_map: [
            {
              citation_ids: [citationId],
              claim_key: 'transport-permit',
              claim_text: credentialText,
            },
          ],
        },
      ],
    };
    const baseWriterInput = multiPlatformWriterInput(fixture.input as JsonObject, ['lieju']);
    const baseStrategy = baseWriterInput['strategy'] as JsonObject;
    const writerInput = {
      ...baseWriterInput,
      brief: {
        ...(baseWriterInput['brief'] as JsonObject),
        constraints: {
          ...((baseWriterInput['brief'] as JsonObject)['constraints'] as JsonObject),
          authorized_certificate_source_ids: [sourceId],
        },
      },
      citations: [
        {
          chunk_id: citationId,
          citation_id: citationId,
          quote_text:
            '资料类型：企业证照\n证照名称：道路运输经营许可证\n持证主体：广州志远搬家服务有限公司',
          source_id: sourceId,
        },
      ],
      strategy: {
        ...baseStrategy,
        profile: {
          ...(baseStrategy['profile'] as JsonObject),
          positioning: '广州志远搬家服务有限公司面向广州提供搬迁服务。',
        },
      },
    } as JsonObject;
    const adapter = new LooseMockAdapter(
      [{ text: JSON.stringify(unsupported) }, { text: JSON.stringify(repaired) }],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );

    const master = await writer.generateMaster({
      context: context(MASTER_RUN, null),
      requestId: 'runtime-lieju-credential-repair-0162',
      writerInput,
    });
    const generatedVariant = await writer.generateVariant({
      context: context(VARIANT_RUN, '72000000-0000-4000-8000-000000000162'),
      masterContent: master,
      platformCode: 'lieju',
      requestId: 'runtime-lieju-credential-variant-0162',
      writerInput,
    });

    expect(generatedVariant.citation_map).toEqual(repaired.variants[0]!.citation_map);
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
      '必须通过 citation_map 关联',
    );
    expect(adapter.requests[1]!.tools).toBeUndefined();
  });

  it.each(['baijiahao', 'lieju', 'sohu'] as const)(
    'uses a bounded targeted repair when initial %s generation still has an unsupported credential after the full retry',
    async (platformCode) => {
      const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
      const clean = multiPlatformContentData([platformCode], new Set());
      const variant = clean.variants[0]!;
      const citationId = '10000000-0000-4000-8000-000000000168';
      const sourceId = '20000000-0000-4000-8000-000000000168';
      const masterBlockIndex = clean.master_content.blocks.length - 1;
      const variantBlockIndex = variant.blocks.length - 1;
      const credentialText = '公司持有道路运输经营许可证。';
      const unsupported = {
        master_content: {
          ...clean.master_content,
          blocks: clean.master_content.blocks.map((block, index) =>
            index === masterBlockIndex
              ? { ...block, text: `${block.text}${credentialText}` }
              : block,
          ),
        },
        variants: [
          {
            ...variant,
            blocks: variant.blocks.map((block, index) =>
              index === variantBlockIndex
                ? { ...block, text: `${block.text}${credentialText}` }
                : block,
            ),
          },
        ],
      };
      const targetedRepair = {
        replacements: [
          {
            replacement_text: clean.master_content.blocks[masterBlockIndex]!.text,
            target_id: `master_content.blocks[${masterBlockIndex}].text`,
          },
          {
            replacement_text: variant.blocks[variantBlockIndex]!.text,
            target_id: `variants.${platformCode}.blocks[${variantBlockIndex}].text`,
          },
        ],
      };
      const adapter = new LooseMockAdapter(
        [
          { text: JSON.stringify(unsupported) },
          { text: JSON.stringify(unsupported) },
          { text: JSON.stringify(targetedRepair) },
        ],
        'deepseek-v4-flash',
      );
      const writer = new RuntimeContentWriter(
        {} as postgres.Sql,
        new Map([['deepseek-v4-flash', adapter]]),
        vi.fn(),
        async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
      );
      const baseWriterInput = multiPlatformWriterInput(fixture.input as JsonObject, [platformCode]);
      const baseBrief = baseWriterInput['brief'] as JsonObject;
      const baseStrategy = baseWriterInput['strategy'] as JsonObject;
      const writerInput = {
        ...baseWriterInput,
        brief: {
          ...baseBrief,
          constraints: {
            ...(baseBrief['constraints'] as JsonObject),
            authorized_certificate_source_ids: [sourceId],
          },
        },
        citations: [
          {
            chunk_id: citationId,
            citation_id: citationId,
            quote_text:
              '资料类型：企业证照\n证照名称：道路运输经营许可证\n持证主体：广州志远搬家服务有限公司',
            source_id: sourceId,
          },
        ],
        strategy: {
          ...baseStrategy,
          profile: {
            ...(baseStrategy['profile'] as JsonObject),
            positioning: '广州志远搬家服务有限公司面向广州提供搬迁服务。',
          },
        },
      } as JsonObject;

      const master = await writer.generateMaster({
        context: context(MASTER_RUN, null),
        requestId: `runtime-${platformCode}-initial-credential-final-repair`,
        writerInput,
      });
      const generatedVariant = await writer.generateVariant({
        context: context(VARIANT_RUN, `72000000-0000-4000-8000-000000000168`),
        masterContent: master,
        platformCode,
        requestId: `runtime-${platformCode}-initial-credential-final-repair-variant`,
        writerInput,
      });

      expect(master.blocks.map((block) => block.text).join('\n')).not.toContain(credentialText);
      expect(generatedVariant.blocks.map((block) => block.text).join('\n')).not.toContain(
        credentialText,
      );
      expect(adapter.requests).toHaveLength(3);
      expect(adapter.requests[2]!.tools).toBeUndefined();
    },
  );

  it('uses a targeted repair to remove only unsupported credentials and preserve cited credentials', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const clean = multiPlatformContentData(['lieju'], new Set());
    const supportedCredentialText = '公司持有道路运输经营许可证。';
    const unsupportedCredentialText = '公司持有安全生产许可证。';
    const credentialText = `${supportedCredentialText}${unsupportedCredentialText}`;
    const citationId = '10000000-0000-4000-8000-000000000164';
    const sourceId = '20000000-0000-4000-8000-000000000164';
    const citationMap = [
      {
        citation_ids: [citationId],
        claim_key: 'transport-permit',
        claim_text: supportedCredentialText,
      },
    ];
    const unsupported = {
      master_content: {
        ...clean.master_content,
        blocks: clean.master_content.blocks.map((block, index) =>
          index === clean.master_content.blocks.length - 1
            ? { ...block, text: `${block.text}${credentialText}` }
            : block,
        ),
        citation_map: citationMap,
      },
      variants: [
        {
          ...clean.variants[0]!,
          blocks: clean.variants[0]!.blocks.map((block, index) =>
            index === clean.variants[0]!.blocks.length - 1
              ? { ...block, text: `${block.text}${credentialText}` }
              : block,
          ),
          citation_map: citationMap,
        },
      ],
    };
    const masterBlockIndex = clean.master_content.blocks.length - 1;
    const variantBlockIndex = clean.variants[0]!.blocks.length - 1;
    const targetedRepair = {
      replacements: [
        {
          replacement_text: `${clean.master_content.blocks[masterBlockIndex]!.text}${supportedCredentialText}`,
          target_id: `master_content.blocks[${masterBlockIndex}].text`,
        },
        {
          replacement_text: `${clean.variants[0]!.blocks[variantBlockIndex]!.text}${supportedCredentialText}`,
          target_id: `variants.lieju.blocks[${variantBlockIndex}].text`,
        },
      ],
    };
    const baseWriterInput = multiPlatformWriterInput(fixture.input as JsonObject, ['lieju']);
    const baseStrategy = baseWriterInput['strategy'] as JsonObject;
    const writerInput = {
      ...baseWriterInput,
      brief: {
        ...(baseWriterInput['brief'] as JsonObject),
        constraints: {
          ...((baseWriterInput['brief'] as JsonObject)['constraints'] as JsonObject),
          authorized_certificate_source_ids: [sourceId],
        },
      },
      citations: [
        {
          chunk_id: citationId,
          citation_id: citationId,
          quote_text:
            '资料类型：企业证照\n证照名称：道路运输经营许可证\n持证主体：广州志远搬家服务有限公司',
          source_id: sourceId,
        },
      ],
      strategy: {
        ...baseStrategy,
        profile: {
          ...(baseStrategy['profile'] as JsonObject),
          positioning: '广州志远搬家服务有限公司面向广州提供搬迁服务。',
        },
      },
    } as JsonObject;
    const adapter = new LooseMockAdapter(
      [
        { text: JSON.stringify(unsupported) },
        { text: JSON.stringify(unsupported) },
        { text: JSON.stringify(targetedRepair) },
      ],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const currentContent = {
      ...unsupported.variants[0]!,
      schema_version: 'content-writer-data@1' as const,
    } as unknown as GeneratedContent;

    const rewritten = await writer.rewriteBrowserPlatformVariant({
      context: { ...context(MASTER_RUN, null), modelPolicy: 'quality' },
      currentContent,
      issues: [
        'deterministic.fact.external_credential_requires_evidence | blocks.section-7 | 资质声明缺少证据 | 删除该声明或补齐引用',
      ],
      platformCode: 'lieju',
      requestId: 'runtime-lieju-final-credential-repair-0164',
      writerInput,
    });

    expect(adapter.requests).toHaveLength(3);
    const finalPrompt = adapter.requests[2]!.messages.map((message) => message.content).join('\n');
    expect(finalPrompt).toContain('bounded targeted repair stage');
    expect(finalPrompt).toContain('unsupported_credential_claims');
    expect(finalPrompt).toContain(`variants.lieju.blocks[${variantBlockIndex}].text`);
    expect(adapter.requests.every((request) => !request.tools?.length)).toBe(true);
    expect(rewritten.title).toBe(clean.variants[0]!.title);
    expect(rewritten.blocks.slice(0, -1)).toEqual(clean.variants[0]!.blocks.slice(0, -1));
    expect(rewritten.blocks.map((block) => block.text).join('\n')).toContain('道路运输经营许可证');
    expect(rewritten.blocks.map((block) => block.text).join('\n')).not.toContain('安全生产许可证');
    expect(rewritten.citation_map).toEqual(citationMap);
  });

  it('repairs unsupported credentials together with a Lieju promotional term', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const clean = multiPlatformContentData(['lieju'], new Set());
    const credentialText = '公司持有道路运输经营许可证。';
    const promotionalText = '这是最好的选择。';
    const masterBlockIndex = clean.master_content.blocks.length - 1;
    const variantBlockIndex = clean.variants[0]!.blocks.length - 1;
    const unsupported = {
      master_content: {
        ...clean.master_content,
        blocks: clean.master_content.blocks.map((block, index) =>
          index === masterBlockIndex ? { ...block, text: `${block.text}${credentialText}` } : block,
        ),
      },
      variants: [
        {
          ...clean.variants[0]!,
          blocks: clean.variants[0]!.blocks.map((block, index) =>
            index === variantBlockIndex
              ? { ...block, text: `${block.text}${credentialText}${promotionalText}` }
              : block,
          ),
        },
      ],
    };
    const targetedRepair = {
      replacements: [
        {
          replacement_text: clean.master_content.blocks[masterBlockIndex]!.text,
          target_id: `master_content.blocks[${masterBlockIndex}].text`,
        },
        {
          replacement_text: `${clean.variants[0]!.blocks[variantBlockIndex]!.text}可结合需求比较服务流程。`,
          target_id: `variants.lieju.blocks[${variantBlockIndex}].text`,
        },
      ],
    };
    const adapter = new LooseMockAdapter(
      [
        { text: JSON.stringify(unsupported) },
        { text: JSON.stringify(unsupported) },
        { text: JSON.stringify(targetedRepair) },
      ],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );

    const rewritten = await writer.rewriteBrowserPlatformVariant({
      context: { ...context(MASTER_RUN, null), modelPolicy: 'quality' },
      currentContent: {
        ...unsupported.variants[0]!,
        schema_version: 'content-writer-data@1' as const,
      } as unknown as GeneratedContent,
      issues: [
        'deterministic.fact.external_credential_requires_evidence | blocks.section-7 | 资质声明缺少证据 | 删除该声明或补齐引用',
        'deterministic.lieju.prohibited_promotional_term | blocks.section-7 | 包含最好 | 删除原词',
      ],
      platformCode: 'lieju',
      requestId: 'runtime-lieju-mixed-targeted-repair-0167',
      writerInput: multiPlatformWriterInput(fixture.input as JsonObject, ['lieju']),
    });

    expect(adapter.requests).toHaveLength(3);
    const finalPrompt = adapter.requests[2]!.messages.map((message) => message.content).join('\n');
    expect(finalPrompt).toContain('unsupported_credential_claims');
    expect(finalPrompt).toContain('prohibited_promotional_terms');
    expect(rewritten.blocks.map((block) => block.text).join('\n')).not.toContain(
      '道路运输经营许可证',
    );
    expect(rewritten.blocks.map((block) => block.text).join('\n')).not.toContain('最好');
  });

  it('stops after two bounded targeted credential repairs remain unsupported', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const clean = multiPlatformContentData(['lieju'], new Set());
    const credentialText = '公司持有营业执照、道路运输经营许可证。';
    const unsupported = {
      master_content: {
        ...clean.master_content,
        blocks: clean.master_content.blocks.map((block, index) =>
          index === clean.master_content.blocks.length - 1
            ? { ...block, text: `${block.text}${credentialText}` }
            : block,
        ),
      },
      variants: [
        {
          ...clean.variants[0]!,
          blocks: clean.variants[0]!.blocks.map((block, index) =>
            index === clean.variants[0]!.blocks.length - 1
              ? { ...block, text: `${block.text}${credentialText}` }
              : block,
          ),
        },
      ],
    };
    const masterBlockIndex = clean.master_content.blocks.length - 1;
    const variantBlockIndex = clean.variants[0]!.blocks.length - 1;
    const invalidTargetedRepair = {
      replacements: [
        {
          replacement_text: `请核验。${credentialText}`,
          target_id: `master_content.blocks[${masterBlockIndex}].text`,
        },
        {
          replacement_text: `请核验。${credentialText}`,
          target_id: `variants.lieju.blocks[${variantBlockIndex}].text`,
        },
      ],
    };
    const adapter = new LooseMockAdapter(
      [
        { text: JSON.stringify(unsupported) },
        { text: JSON.stringify(unsupported) },
        { text: JSON.stringify(invalidTargetedRepair) },
        { text: JSON.stringify(invalidTargetedRepair) },
      ],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const currentContent = {
      ...unsupported.variants[0]!,
      schema_version: 'content-writer-data@1' as const,
    } as unknown as GeneratedContent;

    await expect(
      writer.rewriteBrowserPlatformVariant({
        context: { ...context(MASTER_RUN, null), modelPolicy: 'quality' },
        currentContent,
        issues: [
          'deterministic.fact.external_credential_requires_evidence | blocks.section-7 | 资质声明缺少证据 | 删除该声明或补齐引用',
        ],
        platformCode: 'lieju',
        requestId: 'runtime-lieju-final-credential-failure-0165',
        writerInput: multiPlatformWriterInput(fixture.input as JsonObject, ['lieju']),
      }),
    ).rejects.toMatchObject({
      code: 'CONTENT_QUALITY_INSUFFICIENT',
      message: expect.stringMatching(
        /必须通过 citation_map 关联.*targeted_repair_rejected:replacement_still_contains_unsupported_credential/u,
      ),
    });

    expect(adapter.requests).toHaveLength(4);
    expect(adapter.requests[3]!.messages.map((message) => message.content).join('\n')).toContain(
      'replacement_still_contains_unsupported_credential',
    );
  });

  it('never changes a locked block during targeted credential repair', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const clean = multiPlatformContentData(['lieju'], new Set());
    const variant = clean.variants[0]!;
    const blockIndex = variant.blocks.length - 1;
    const citationId = '10000000-0000-4000-8000-000000000166';
    const sourceId = '20000000-0000-4000-8000-000000000166';
    const credentialText = `${variant.blocks[blockIndex]!.text}公司持有营业执照。`;
    const unsupported = {
      ...clean,
      variants: [
        {
          ...variant,
          blocks: variant.blocks.map((block, index) =>
            index === blockIndex ? { ...block, text: credentialText } : block,
          ),
          citation_map: [
            ...variant.citation_map,
            {
              citation_ids: [citationId],
              claim_key: 'locked-credential',
              claim_text: credentialText,
            },
          ],
        },
      ],
    };
    const baseInput = multiPlatformWriterInput(fixture.input as JsonObject, ['lieju']);
    const writerInput = {
      ...baseInput,
      citations: [
        {
          chunk_id: '30000000-0000-4000-8000-000000000166',
          citation_id: citationId,
          quote_text: '企业资料介绍了基础服务安排。',
          source_id: sourceId,
        },
      ],
      locked_blocks: [
        {
          block_key: variant.blocks[blockIndex]!.block_key,
          citation_ids: [citationId],
          platform_code: 'lieju',
          text: credentialText,
        },
      ],
    } as JsonObject;
    const adapter = new LooseMockAdapter(
      [{ text: JSON.stringify(unsupported) }, { text: JSON.stringify(unsupported) }],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );

    await expect(
      writer.rewriteBrowserPlatformVariant({
        context: { ...context(MASTER_RUN, null), modelPolicy: 'quality' },
        currentContent: {
          ...unsupported.variants[0]!,
          schema_version: 'content-writer-data@1' as const,
        } as unknown as GeneratedContent,
        issues: ['资质声明缺少证据'],
        platformCode: 'lieju',
        requestId: 'runtime-lieju-locked-credential-0166',
        writerInput,
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_QUALITY_INSUFFICIENT' });

    expect(adapter.requests).toHaveLength(2);
  });

  it('does not accept a structured certificate citation from an unauthorized source', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const base = multiPlatformContentData(['lieju'], new Set());
    const variant = base.variants[0]!;
    const unsupported = {
      ...base,
      variants: [
        {
          ...variant,
          blocks: variant.blocks.map((block, index) =>
            index === variant.blocks.length - 1
              ? { ...block, text: `${block.text}公司持有道路运输经营许可证。` }
              : block,
          ),
          citation_map: [
            {
              citation_ids: ['10000000-0000-4000-8000-000000000163'],
              claim_key: 'transport-permit',
              claim_text: '公司持有道路运输经营许可证。',
            },
          ],
        },
      ],
    };
    const baseWriterInput = multiPlatformWriterInput(fixture.input as JsonObject, ['lieju']);
    const baseStrategy = baseWriterInput['strategy'] as JsonObject;
    const writerInput = {
      ...baseWriterInput,
      citations: [
        {
          chunk_id: '10000000-0000-4000-8000-000000000163',
          citation_id: '10000000-0000-4000-8000-000000000163',
          quote_text:
            '资料类型：企业证照\n证照名称：道路运输经营许可证\n持证主体：广州志远搬家服务有限公司',
          source_id: '20000000-0000-4000-8000-000000000163',
        },
      ],
      strategy: {
        ...baseStrategy,
        profile: {
          ...(baseStrategy['profile'] as JsonObject),
          positioning: '广州志远搬家服务有限公司面向广州提供搬迁服务。',
        },
      },
    } as JsonObject;
    const adapter = new LooseMockAdapter(
      [{ text: JSON.stringify(unsupported) }, { text: JSON.stringify(base) }],
      'deepseek-v4-flash',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-flash', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );

    const master = await writer.generateMaster({
      context: context(MASTER_RUN, null),
      requestId: 'runtime-lieju-credential-unauthorized-0163',
      writerInput,
    });
    await writer.generateVariant({
      context: context(VARIANT_RUN, '72000000-0000-4000-8000-000000000163'),
      masterContent: master,
      platformCode: 'lieju',
      requestId: 'runtime-lieju-credential-unauthorized-variant-0163',
      writerInput,
    });

    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
      '必须通过 citation_map 关联',
    );
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

  it('uses the current tenant owner policy without inheriting the legacy tenant', async () => {
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const owner = '广州众人搬家起重吊装有限公司';
    const legacyOwner = '广州志远搬家服务有限公司';
    const cleanArticle = officialSiteArticleDraft();
    const withCompany = (companyName: string) => ({
      ...cleanArticle,
      blocks: cleanArticle.blocks.map((block, index) =>
        index === 0
          ? {
              ...block,
              text: `${companyName}可根据现场条件说明服务边界。${block.text.slice(80)}`,
            }
          : block,
      ),
    });
    const adapter = new LooseMockAdapter(
      [
        { text: JSON.stringify(withCompany(legacyOwner)) },
        { text: JSON.stringify(withCompany(owner)) },
      ],
      'deepseek-v4-pro',
    );
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      new Map([['deepseek-v4-pro', adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const writerInput = officialSiteWriterInput(fixture.input as JsonObject, owner);

    const generated = await writer.generateOfficialSiteMaster({
      context: {
        ...context(MASTER_RUN, null),
        modelKey: 'deepseek-v4-pro',
        modelPolicy: 'quality',
      },
      requestId: 'runtime-official-tenant-company-policy-0061',
      writerInput,
    });

    expect(JSON.stringify(generated)).toContain(owner);
    expect(JSON.stringify(generated)).not.toContain(legacyOwner);
    const firstPrompt = adapter.requests[0]!.messages.map((message) => message.content).join('\n');
    expect(firstPrompt).toContain(owner);
    expect(firstPrompt).not.toContain(legacyOwner);
    expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
      legacyOwner,
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
      const expansion =
        platformCode === 'douyin' ? shortDouyinExpansionDraft() : platformExpansionDraft();
      const adapter = new LooseMockAdapter(
        [{ text: JSON.stringify(data) }, { text: JSON.stringify(expansion) }],
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
      if (platformCode === 'douyin') {
        expect(expansion.blocks.every((block) => block.text.length < 100)).toBe(true);
      }
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

function officialSiteWriterInput(
  input: JsonObject,
  ownerCompanyName = '广州志远搬家服务有限公司',
): JsonObject {
  const brief = input['brief'] as JsonObject;
  const rule = (input['platform_rules_by_code'] as JsonObject)['xiaohongshu'] as JsonObject;
  const strategy = input['strategy'] as JsonObject;
  const profile = strategy['profile'] as JsonObject;
  return {
    ...input,
    brief: {
      ...brief,
      constraints: { official_site_direct: true },
      platform_codes: ['official_site'],
      title: '广州家庭搬家前如何核对服务范围与执行人员安排',
    },
    platform_rules_by_code: { official_site: rule },
    strategy: {
      ...strategy,
      profile: {
        ...profile,
        positioning: `${ownerCompanyName}面向广州提供搬迁服务。`,
      },
    },
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
    platform_meta: platformCode === 'douyin' ? douyinImageNoteMeta() : {},
    summary: '文章说明搬家前可执行的服务核对步骤与风险边界。',
    title: '搬家前如何核对服务细节',
  } as const;
}

function douyinImageNoteMeta() {
  return {
    cards: [
      {
        body: '搬家前别急着定方案，先把现场条件和服务边界逐项排清楚。',
        card_key: 'cover',
        heading: '搬家前怎么准备',
        kind: 'cover',
      },
      {
        body: '旧址和新址的楼层、电梯预约、门口停车位置，会影响装卸顺序和等待时间。',
        card_key: 'scenario',
        heading: '先看两边现场条件',
        kind: 'body',
      },
      {
        body: '根据物品体积和道路条件选择车型，同时核对车辆能否进入两端装卸点。',
        card_key: 'criteria',
        heading: '车型要按条件判断',
        kind: 'body',
      },
      {
        body: '先分房间清点物品；再标记大件和易碎品；最后确认拆装与复位顺序。',
        card_key: 'steps',
        heading: '物品按三步准备',
        kind: 'body',
      },
      {
        body: '注意临时加项、超时等待和无法停车等风险，不能只比较一个打包总价。',
        card_key: 'risk',
        heading: '这些临时风险要确认',
        kind: 'body',
      },
      {
        body: '按现场条件选车型，按清单准备物品，并把时间、费用和异常处理逐项确认。',
        card_key: 'summary',
        heading: '最后按清单再核对',
        kind: 'summary',
      },
    ],
    content_kind: 'image_note',
    description: DOUYIN_NARRATIVE_DESCRIPTION,
    topics: ['搬家准备', '搬家指南', '搬家避坑', '广州搬家'],
  } as const;
}

const DOUYIN_NARRATIVE_DESCRIPTION = [
  '一份搬家服务选择指南。广州跨区搬家涉及两端楼层、电梯预约、停车位置和物品拆装，任一条件遗漏都容易带来等待、临时加项或物品磕碰。',
  '确定方案前应核对新旧地址的通道、门洞、装卸距离和可作业时间，记录大件、易碎品与需要拆装的家具。现场信息越完整，车型、人员和搬运顺序越容易评估，也能减少到场后反复调整。',
  '报价环节要把运输、人工、拆装、包装、楼层和等待等项目分别确认，并写清哪些情况会增加费用。只拿一个总价比较，很难判断服务范围是否一致；把服务边界落在书面约定里，后续核对更直接。',
  '物品防护与责任处理也要提前谈清。易碎品可按类别包装，大件家具需要确认拆装方式，贵重或特殊物品应单独记录；交接时按清单验收，发现磕碰或缺件便于按约定处理。',
  '预约时间会影响车辆调度和整体工期。遇到电梯限时、园区进场登记或道路临停限制，应预留沟通时间，并确认计划变化时的响应方式，避免人员和车辆到场后长时间等待。',
  '实操可按四点核对：第一，比较两到三份服务方案，确认项目口径一致；第二，把易碎品、大件和特殊物品单独列出；第三，确认电梯、停车和进场时间；第四，把费用变化条件、责任划分和验收方式写进约定。',
  '搬家方案需要结合物品规模、两端现场和时间要求综合判断。对照现场记录、分项报价、防护安排与异常处理方式逐项选择，能够减少临时变更带来的风险。',
].join('\n\n');

const PLATFORM_STRUCTURES = {
  master: { blocks: 8, headings: 3 },
  official_site: { blocks: 8, headings: 3 },
  baijiahao: { blocks: 7, headings: 2 },
  sohu: { blocks: 7, headings: 2 },
  lieju: { blocks: 7, headings: 2 },
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

function shortDouyinExpansionDraft() {
  const text = (label: string) =>
    `${label}时先核对现场条件与书面约定，再记录执行顺序、责任边界和异常处理办法，完成后按清单逐项复核。把车辆、物品、费用和验收结果分别留痕，发现差异时先停止确认并补齐书面记录。`;
  return {
    blocks: Array.from({ length: 5 }, (_, index) => ({
      block_type: index === 2 ? ('list' as const) : ('paragraph' as const),
      citation_ids: [],
      text: text(`补充第${index + 1}项`),
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
