import { MockModelAdapter, type JsonObject, type JsonValue } from '@geo-content-os/adapter-model';
import { DeepSeekModelAdapter } from '@geo-content-os/adapter-model-deepseek';
import { GET_STRATEGY_VERSION_TOOL, SEARCH_KNOWLEDGE_TOOL } from '@geo-content-os/contracts/skills';
import {
  createSkillContext,
  SchemaGuard,
  SkillRunner,
  type SkillTool,
  ToolRegistry,
} from '@geo-content-os/skills/runtime';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOPIC_PLANNER_CONTRACT_V1 } from '../contracts/v1.0.0/index.js';
import { TopicPlannerSkill } from './topic-planner.skill.js';

const closers: Array<() => Promise<void>> = [];
const fixture = TOPIC_PLANNER_CONTRACT_V1.fewShots[0]!;
const context = createSkillContext({
  inputHash: 'b'.repeat(64),
  modelKey: 'pro',
  projectId: '40000000-0000-4000-8000-000000000065',
  promptVersionId: '80000000-0000-4000-8000-000000000065',
  requestId: 'request-topic-planner-0065',
  runId: '70000000-0000-4000-8000-000000000065',
  skillName: 'topic-planner',
  skillVersion: '1.0.0',
  tenantId: '90000000-0000-4000-8000-000000000065',
  workspaceId: '30000000-0000-4000-8000-000000000065',
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('TopicPlannerSkill', () => {
  it('uses the frozen tool whitelist and grounds evidence IDs with the Mock Adapter', async () => {
    const search = vi.fn(() => fixture.toolResults as unknown as JsonValue);
    const adapter = new MockModelAdapter({
      modelKey: 'pro',
      responses: [strategyCall(), searchCall(), { text: JSON.stringify(fixture.output) }],
    });

    const result = await skill(adapter, search).run({
      context,
      input: fixture.input,
      recordUsage: () => undefined,
    });

    expect(result).toMatchObject({ output: fixture.output, toolCallCount: 2 });
    expect(result.toolResults.map((item) => item.name)).toEqual([
      'get_strategy_version',
      'search_knowledge',
    ]);
    expect(search).toHaveBeenCalledOnce();
  });

  it('accepts evidence-free topics only with high risk and a warning', async () => {
    const boundary = TOPIC_PLANNER_CONTRACT_V1.fewShots[1]!;
    const adapter = new MockModelAdapter({
      modelKey: 'pro',
      responses: [{ text: JSON.stringify(boundary.output) }],
    });
    await expect(
      skill(adapter).run({ context, input: boundary.input, recordUsage: () => undefined }),
    ).resolves.toMatchObject({ output: { warnings: [{ code: 'NO_EVIDENCE' }] } });
  });

  it('rejects a fabricated evidence ID', async () => {
    const forged = {
      ...fixture.output,
      data: {
        topics: [
          {
            ...fixture.output.data.topics[0]!,
            evidence_ids: ['61000000-0000-4000-8000-000000000065'],
          },
        ],
      },
    };
    const adapter = new MockModelAdapter({
      modelKey: 'pro',
      responses: [searchCall(), { text: JSON.stringify(forged) }],
    });
    await expect(
      skill(adapter, () => fixture.toolResults as unknown as JsonValue).run({
        context,
        input: fixture.input,
        recordUsage: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it('runs through the real DeepSeek Adapter using JSON mode and authorized tools', async () => {
    const boundary = TOPIC_PLANNER_CONTRACT_V1.fewShots[1]!;
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
              message: { content: JSON.stringify(boundary.output), role: 'assistant' },
            },
          ],
          id: 'topic-planner-provider-request',
          model: 'configured-provider-model',
          usage: { completion_tokens: 190, prompt_tokens: 520, total_tokens: 710 },
        }),
      );
    });
    const adapter = new DeepSeekModelAdapter({
      apiKey: 'test-secret',
      baseUrl,
      maxOutputTokens: 8_192,
      maxRetries: 0,
      modelKey: 'pro',
      providerModelId: 'configured-provider-model',
      retryBaseDelayMs: 0,
      timeoutMs: 2_000,
    });

    await expect(
      skill(adapter).run({ context, input: boundary.input, recordUsage: () => undefined }),
    ).resolves.toMatchObject({ output: { skill_name: 'topic-planner' } });
    expect(requestBody).toMatchObject({
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });
    expect(requestBody?.['tools']).toHaveLength(2);
  });
});

function strategyCall() {
  return {
    toolCalls: [
      {
        arguments: { brand_profile_id: '10000000-0000-4000-8000-000000000065' },
        id: 'strategy-call-1',
        name: 'get_strategy_version',
      },
    ],
  };
}

function searchCall() {
  return {
    toolCalls: [
      {
        arguments: {
          query: '企业 GEO 内容流程',
          top_k: 5,
          trust_levels: ['verified', 'normal'],
        },
        id: 'search-call-1',
        name: 'search_knowledge',
      },
    ],
  };
}

function skill(
  adapter: ConstructorParameters<typeof SkillRunner>[0],
  search: SkillTool['execute'] = () => [],
): TopicPlannerSkill {
  const schemas = new SchemaGuard();
  return new TopicPlannerSkill(
    new SkillRunner(
      adapter,
      schemas,
      new ToolRegistry(
        [
          tool(GET_STRATEGY_VERSION_TOOL, () => ({ profile: {}, version: 3 })),
          tool(SEARCH_KNOWLEDGE_TOOL, search),
        ],
        schemas,
      ),
    ),
  );
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
    allowedSkills: ['topic-planner'] as const,
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
