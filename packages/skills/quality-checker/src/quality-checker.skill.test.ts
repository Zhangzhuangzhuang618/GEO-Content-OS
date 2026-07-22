import { MockModelAdapter, type JsonObject } from '@geo-content-os/adapter-model';
import { DeepSeekModelAdapter } from '@geo-content-os/adapter-model-deepseek';
import {
  CREATE_QUALITY_ISSUE_TOOL,
  GET_PLATFORM_RULES_TOOL,
  REQUEST_HUMAN_REVIEW_TOOL,
  SEARCH_KNOWLEDGE_TOOL,
} from '@geo-content-os/contracts/skills';
import {
  createSkillContext,
  SchemaGuard,
  SkillRunner,
  type SkillTool,
  ToolRegistry,
} from '@geo-content-os/skills/runtime';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { QUALITY_CHECKER_CONTRACT_V1 } from '../contracts/v1.0.0/index.js';
import { QualityCheckerSkill } from './quality-checker.skill.js';

const closers: Array<() => Promise<void>> = [];
const fixture = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
const context = createSkillContext({
  inputHash: 'd'.repeat(64),
  modelKey: 'flash',
  projectId: '80000000-0000-4000-8000-000000000069',
  promptVersionId: '70000000-0000-4000-8000-000000000069',
  requestId: 'request-quality-checker-0069',
  runId: '60000000-0000-4000-8000-000000000069',
  skillName: 'quality-checker',
  skillVersion: '1.0.0',
  tenantId: '90000000-0000-4000-8000-000000000069',
  workspaceId: 'a0000000-0000-4000-8000-000000000069',
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('QualityCheckerSkill', () => {
  it('uses the frozen tool whitelist with the Mock Adapter', async () => {
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [rulesCall(), { text: JSON.stringify(fixture.output.data) }],
    });
    const result = await skill(adapter).run({
      context,
      input: fixture.input,
      recordUsage: () => undefined,
    });
    expect(result).toMatchObject({ output: { data: fixture.output.data }, toolCallCount: 1 });
    expect(result.toolResults.map((item) => item.name)).toEqual(['get_platform_rules']);
  });

  it('rejects failure to block a high-risk unsupported fact', async () => {
    const negative = QUALITY_CHECKER_CONTRACT_V1.fewShots[1]!;
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(fixture.output.data) }],
    });
    await expect(
      skill(adapter).run({ context, input: negative.input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it('enforces the warning threshold boundary', async () => {
    const boundary = QUALITY_CHECKER_CONTRACT_V1.fewShots[2]!;
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(boundary.output.data) }],
    });
    await expect(
      skill(adapter).run({ context, input: boundary.input, recordUsage: () => undefined }),
    ).resolves.toMatchObject({ output: { data: { decision: 'revise' } } });
  });

  it('runs through the real DeepSeek Adapter with JSON mode and four tools', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const baseUrl = await serve(async (incoming, outgoing) => {
      requestBody = JSON.parse(await body(incoming)) as Record<string, unknown>;
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: { content: JSON.stringify(fixture.output.data), role: 'assistant' },
            },
          ],
          id: 'quality-provider-request',
          model: 'configured-provider-model',
          usage: { completion_tokens: 140, prompt_tokens: 380, total_tokens: 520 },
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
      skill(adapter).run({
        context,
        input: fixture.input,
        prompt: {
          systemPrompt: '官网第一方经营事实以已发布品牌档案为准。',
          taskTemplate: '不得因为缺少公开链接要求企业重复确认。',
        },
        recordUsage: () => undefined,
      }),
    ).resolves.toMatchObject({ output: { skill_name: 'quality-checker' } });
    expect(requestBody).toMatchObject({ response_format: { type: 'json_object' }, temperature: 0 });
    expect(requestBody?.['tools']).toHaveLength(4);
    expect(JSON.stringify(requestBody?.['messages'])).toContain(
      'enterprise-approved first-party source',
    );
    expect(JSON.stringify(requestBody?.['messages'])).toContain(
      '不得因为缺少公开链接要求企业重复确认',
    );
  });
});

function rulesCall() {
  return {
    toolCalls: [
      {
        arguments: {
          platform_code: 'wechat_mp',
          version_id: '40000000-0000-4000-8000-000000000069',
        },
        id: 'rules-1',
        name: 'get_platform_rules',
      },
    ],
  };
}
function skill(adapter: ConstructorParameters<typeof SkillRunner>[0]): QualityCheckerSkill {
  const schemas = new SchemaGuard();
  const definitions = [
    GET_PLATFORM_RULES_TOOL,
    SEARCH_KNOWLEDGE_TOOL,
    CREATE_QUALITY_ISSUE_TOOL,
    REQUEST_HUMAN_REVIEW_TOOL,
  ];
  return new QualityCheckerSkill(
    new SkillRunner(
      adapter,
      schemas,
      new ToolRegistry(
        definitions.map((definition) => tool(definition)),
        schemas,
      ),
    ),
  );
}
function tool(definition: {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly name: string;
}): SkillTool {
  const execute: SkillTool['execute'] = (args) => args;
  return Object.freeze({
    allowedSkills: ['quality-checker'] as const,
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
    Promise.resolve(handler(incoming, outgoing)).catch((error: unknown) =>
      outgoing.destroy(error instanceof Error ? error : undefined),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
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
