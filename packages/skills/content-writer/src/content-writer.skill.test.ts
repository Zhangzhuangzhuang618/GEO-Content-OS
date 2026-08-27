import { MockModelAdapter, type JsonObject } from '@geo-content-os/adapter-model';
import { DeepSeekModelAdapter } from '@geo-content-os/adapter-model-deepseek';
import {
  CONTENT_WRITER_OUTPUT_SCHEMA,
  GET_PLATFORM_RULES_TOOL,
  GET_STRATEGY_VERSION_TOOL,
} from '@geo-content-os/contracts/skills';
import {
  createSkillContext,
  SchemaGuard,
  SkillRunner,
  type SkillTool,
  ToolRegistry,
} from '@geo-content-os/skills/runtime';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONTENT_WRITER_CONTRACT_V1 } from '../contracts/v1.0.0/index.js';
import { ContentWriterSkill } from './content-writer.skill.js';

const closers: Array<() => Promise<void>> = [];
const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
const context = createSkillContext({
  inputHash: 'a'.repeat(64),
  modelKey: 'flash',
  projectId: null,
  promptVersionId: '80000000-0000-4000-8000-000000000061',
  requestId: 'request-content-writer-0061',
  runId: '70000000-0000-4000-8000-000000000061',
  skillName: 'content-writer',
  skillVersion: '1.0.0',
  tenantId: '90000000-0000-4000-8000-000000000061',
  workspaceId: '91000000-0000-4000-8000-000000000061',
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('ContentWriterSkill', () => {
  it('publishes the Lieju question-title and literal-contact boundary', () => {
    expect(CONTENT_WRITER_CONTRACT_V1.prompt.version).toBe('content-writer-prompt@1.1.10');
    expect(CONTENT_WRITER_CONTRACT_V1.platformPrompts.douyin).toContain('content_kind=image_note');
    expect(CONTENT_WRITER_CONTRACT_V1.platformPrompts.douyin).toContain('6-9 张');
    expect(CONTENT_WRITER_CONTRACT_V1.platformPrompts.douyin).toContain('420-900 字');
    expect(CONTENT_WRITER_CONTRACT_V1.platformPrompts.douyin).toContain('第一句点明具体主题');
    expect(CONTENT_WRITER_CONTRACT_V1.platformPrompts.douyin).toContain('自然提及一次本企业全称');
    expect(CONTENT_WRITER_CONTRACT_V1.platformPrompts.douyin).toContain('同义重复');
    expect(CONTENT_WRITER_CONTRACT_V1.platformPrompts.lieju).toContain(
      '自然使用“如何、怎么、指南、方法、哪些”等问法之一',
    );
    expect(CONTENT_WRITER_CONTRACT_V1.platformPrompts.lieju).toContain(
      '“通过页面联系方式咨询”属于允许的中性引导',
    );
    expect(CONTENT_WRITER_CONTRACT_V1.platformPrompts.lieju).toContain('具体电话或手机号');
    expect(CONTENT_WRITER_CONTRACT_V1.platformPrompts.lieju).toContain('任何含“百分百”的表达');
    expect(CONTENT_WRITER_CONTRACT_V1.platformPrompts.lieju).toContain(
      '即使这些词出现在否定、引用或举例中',
    );
  });

  it('runs the frozen Prompt, platform patch, tools, and schema with the Mock Adapter', async () => {
    const recordUsage = vi.fn();
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(fixture.output.data) }],
    });
    const generate = vi.spyOn(adapter, 'generate');

    const result = await skill(adapter).run({ context, input: fixture.input, recordUsage });

    expect(result.output).toMatchObject({
      citations: fixture.output.citations,
      data: fixture.output.data,
      skill_name: 'content-writer',
      skill_version: context.skillVersion,
      status: 'success',
      trace: {
        input_hash: context.inputHash,
        prompt_version_id: context.promptVersionId,
        request_id: context.requestId,
        run_id: context.runId,
      },
      usage: { model_key: context.modelKey, provider: 'mock' },
    });
    expect(new SchemaGuard().check(CONTENT_WRITER_OUTPUT_SCHEMA, result.output)).toMatchObject({
      paths: [],
      valid: true,
    });
    expect(result).toMatchObject({ schemaRepairAttempts: 0, toolCallCount: 0 });
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0].tools?.map((tool) => tool.name)).toEqual([
      'get_strategy_version',
      'get_platform_rules',
    ]);
    expect(JSON.stringify(generate.mock.calls[0]?.[0].messages)).toContain('小红书 xiaohongshu');
    expect(JSON.stringify(generate.mock.calls[0]?.[0].messages)).not.toContain(context.runId);
  });

  it('executes an authorized tool call through the server-owned registry', async () => {
    const execute = vi.fn(() => ({ profile: { tone: 'professional' }, version: 1 }));
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [
        {
          toolCalls: [
            {
              arguments: { brand_profile_id: '20000000-0000-4000-8000-000000000061' },
              id: 'strategy-call-1',
              name: 'get_strategy_version',
            },
          ],
        },
        { text: JSON.stringify(fixture.output.data) },
      ],
    });

    await expect(
      skill(adapter, execute).run({
        context,
        input: fixture.input,
        recordUsage: () => undefined,
      }),
    ).resolves.toMatchObject({ toolCallCount: 1 });
    expect(execute).toHaveBeenCalledWith(
      { brand_profile_id: '20000000-0000-4000-8000-000000000061' },
      context,
      undefined,
    );
  });

  it('rejects a model response that changes a locked block', async () => {
    const boundary = CONTENT_WRITER_CONTRACT_V1.fewShots[2]!;
    const changed = {
      ...boundary.output,
      data: {
        ...boundary.output.data,
        master_content: {
          ...boundary.output.data.master_content,
          blocks: [{ ...boundary.output.data.master_content.blocks[0]!, text: 'changed' }],
        },
      },
    };
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(changed.data) }],
    });

    await expect(
      skill(adapter).run({
        context,
        input: boundary.input,
        recordUsage: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it('rejects claim citations outside the supplied evidence set', async () => {
    const forged = {
      ...fixture.output,
      data: {
        ...fixture.output.data,
        master_content: {
          ...fixture.output.data.master_content,
          citation_map: [
            {
              ...fixture.output.data.master_content.citation_map[0]!,
              citation_ids: ['92000000-0000-4000-8000-000000000061'],
            },
          ],
        },
      },
    };
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(forged.data) }],
    });

    await expect(
      skill(adapter).run({ context, input: fixture.input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it('repairs an empty citation mapping when the brief has no supplied evidence', async () => {
    const noEvidenceInput = { ...fixture.input, citations: [] };
    const noEvidenceData = {
      ...fixture.output.data,
      master_content: { ...fixture.output.data.master_content, citation_map: [] },
      variants: fixture.output.data.variants.map((variant) => ({
        ...variant,
        citation_map: [],
      })),
    };
    const invalidFirstAttempt = {
      ...noEvidenceData,
      master_content: {
        ...noEvidenceData.master_content,
        citation_map: [
          {
            citation_ids: [],
            claim_key: 'uncited-general-advice',
            claim_text: '选择服务商前应核对合同条款。',
          },
        ],
      },
    };
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [
        { text: JSON.stringify(invalidFirstAttempt) },
        { text: JSON.stringify(noEvidenceData) },
      ],
    });

    await expect(
      skill(adapter).run({ context, input: noEvidenceInput, recordUsage: () => undefined }),
    ).resolves.toMatchObject({
      output: {
        citations: [],
        data: {
          master_content: { citation_map: [] },
          variants: [expect.objectContaining({ citation_map: [] })],
        },
      },
      schemaRepairAttempts: 1,
    });
  });

  it('runs through the real DeepSeek Adapter using JSON mode and authorized tools', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const baseUrl = await serve(async (incoming, outgoing) => {
      requestBodies.push(JSON.parse(await body(incoming)) as Record<string, unknown>);
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(
        JSON.stringify({
          choices: [
            requestBodies.length === 1
              ? {
                  finish_reason: 'tool_calls',
                  index: 0,
                  message: {
                    content: '   ',
                    role: 'assistant',
                    tool_calls: [
                      {
                        function: {
                          arguments: JSON.stringify({
                            brand_profile_id: '20000000-0000-4000-8000-000000000061',
                          }),
                          name: 'get_strategy_version',
                        },
                        id: 'strategy-call-1',
                        type: 'function',
                      },
                    ],
                  },
                }
              : {
                  finish_reason: 'stop',
                  index: 0,
                  message: { content: JSON.stringify(fixture.output.data), role: 'assistant' },
                },
          ],
          id: `content-writer-provider-request-${requestBodies.length}`,
          model: 'configured-provider-model',
          usage: { completion_tokens: 260, prompt_tokens: 420, total_tokens: 680 },
        }),
      );
    });
    const adapter = new DeepSeekModelAdapter({
      apiKey: 'test-secret',
      baseUrl,
      maxOutputTokens: 8_192,
      maxRetries: 0,
      modelKey: 'flash',
      providerModelId: 'configured-provider-model',
      retryBaseDelayMs: 0,
      timeoutMs: 2_000,
    });

    await expect(
      skill(adapter).run({ context, input: fixture.input, recordUsage: () => undefined }),
    ).resolves.toMatchObject({ output: { skill_name: 'content-writer' }, toolCallCount: 1 });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({
      response_format: { type: 'json_object' },
      stream: false,
      temperature: 0.4,
    });
    expect(requestBodies[0]?.['tools']).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: 'get_strategy_version' }),
      }),
      expect.objectContaining({
        function: expect.objectContaining({ name: 'get_platform_rules' }),
      }),
    ]);
    const secondMessages = requestBodies[1]?.['messages'] as readonly Record<string, unknown>[];
    expect(secondMessages[11]).toMatchObject({
      content: null,
      role: 'assistant',
      tool_calls: [expect.objectContaining({ id: 'strategy-call-1', type: 'function' })],
    });
  });
});

function skill(
  adapter: ConstructorParameters<typeof SkillRunner>[0],
  executeStrategy: SkillTool['execute'] = () => ({ version: 1 }),
): ContentWriterSkill {
  const schemas = new SchemaGuard();
  const tools = new ToolRegistry(
    [
      tool(GET_STRATEGY_VERSION_TOOL, executeStrategy),
      tool(GET_PLATFORM_RULES_TOOL, () => ({ rules: {}, version: 1 })),
    ],
    schemas,
  );
  return new ContentWriterSkill(new SkillRunner(adapter, schemas, tools));
}

function tool(
  definition: {
    readonly description: string;
    readonly inputSchema: JsonObject;
    readonly name: string;
  },
  execute: SkillTool['execute'],
): SkillTool {
  return Object.freeze({
    allowedSkills: ['content-writer'] as const,
    description: definition.description,
    execute,
    inputSchema: definition.inputSchema,
    name: definition.name,
  });
}

async function serve(
  handler: (incoming: IncomingMessage, outgoing: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer((incoming, outgoing) => {
    Promise.resolve(handler(incoming, outgoing)).catch((error: unknown) => {
      outgoing.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server address missing');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function body(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
