import { MockModelAdapter, type JsonObject, type JsonValue } from '@geo-content-os/adapter-model';
import { DeepSeekModelAdapter } from '@geo-content-os/adapter-model-deepseek';
import { REQUEST_HUMAN_REVIEW_TOOL, SEARCH_KNOWLEDGE_TOOL } from '@geo-content-os/contracts/skills';
import {
  createSkillContext,
  SchemaGuard,
  SkillRunner,
  type SkillTool,
  ToolRegistry,
} from '@geo-content-os/skills/runtime';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FACT_CHECKER_CONTRACT_V1 } from '../contracts/v1.0.0/index.js';
import { FactCheckerSkill } from './fact-checker.skill.js';

const closers: Array<() => Promise<void>> = [];
const fixture = FACT_CHECKER_CONTRACT_V1.fewShots[0]!;
const context = createSkillContext({
  inputHash: 'a'.repeat(64),
  modelKey: 'pro',
  projectId: null,
  promptVersionId: '60000000-0000-4000-8000-000000000063',
  requestId: 'request-fact-checker-0063',
  runId: '50000000-0000-4000-8000-000000000063',
  skillName: 'fact-checker',
  skillVersion: '1.0.0',
  tenantId: '70000000-0000-4000-8000-000000000063',
  workspaceId: '80000000-0000-4000-8000-000000000063',
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('FactCheckerSkill', () => {
  it('uses scoped search results with the Mock Adapter', async () => {
    const search = vi.fn(() => fixture.toolResults as unknown as JsonValue);
    const adapter = new MockModelAdapter({
      modelKey: 'pro',
      responses: [searchCall(), { text: JSON.stringify(fixture.output) }],
    });

    const result = await skill(adapter, search).run({
      context,
      input: fixture.input,
      recordUsage: () => undefined,
    });

    expect(result).toMatchObject({ output: fixture.output, toolCallCount: 1 });
    expect(result.toolResults).toEqual([{ name: 'search_knowledge', output: fixture.toolResults }]);
    expect(search).toHaveBeenCalledWith(
      {
        project_id: null,
        query: '产品 A 于 2025 年 9 月发布。',
        top_k: 5,
        trust_levels: ['verified', 'normal'],
        workspace_id: context.workspaceId,
      },
      context,
      undefined,
    );
  });

  it('accepts unsupported with empty evidence and a blocking decision', async () => {
    const negative = FACT_CHECKER_CONTRACT_V1.fewShots[1]!;
    const adapter = new MockModelAdapter({
      modelKey: 'pro',
      responses: [{ text: JSON.stringify(negative.output) }],
    });

    await expect(
      skill(adapter).run({
        context,
        input: negative.input,
        recordUsage: () => undefined,
      }),
    ).resolves.toMatchObject({ output: { data: { overall_decision: 'block' } } });
  });

  it('rejects evidence not returned by search_knowledge', async () => {
    const adapter = new MockModelAdapter({
      modelKey: 'pro',
      responses: [searchCall(), { text: JSON.stringify(fixture.output) }],
    });

    await expect(
      skill(adapter, () => [
        {
          chunk_id: '40000000-0000-4000-8000-000000000063',
          quote_text: '不同原文',
        },
      ]).run({ context, input: fixture.input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it('runs a real DeepSeek tool round through the local HTTP adapter', async () => {
    let requestCount = 0;
    const baseUrl = await serve(async (_incoming, outgoing) => {
      requestCount += 1;
      json(outgoing, requestCount === 1 ? providerToolCall() : providerOutput(fixture.output));
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
      skill(adapter, () => fixture.toolResults as unknown as JsonValue).run({
        context,
        input: fixture.input,
        recordUsage: () => undefined,
      }),
    ).resolves.toMatchObject({ output: { skill_name: 'fact-checker' }, toolCallCount: 1 });
    expect(requestCount).toBe(2);
  });
});

function searchCall() {
  return {
    toolCalls: [
      {
        arguments: {
          query: '产品 A 于 2025 年 9 月发布。',
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
): FactCheckerSkill {
  const schemas = new SchemaGuard();
  return new FactCheckerSkill(
    new SkillRunner(
      adapter,
      schemas,
      new ToolRegistry(
        [
          tool(SEARCH_KNOWLEDGE_TOOL, search),
          tool(REQUEST_HUMAN_REVIEW_TOOL, () => ({ created: true })),
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
    allowedSkills: ['fact-checker'] as const,
    description: definition.description,
    execute,
    inputSchema: definition.inputSchema,
    name: definition.name,
  });
}

function providerToolCall() {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        index: 0,
        message: {
          content: null,
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify(searchCall().toolCalls[0]!.arguments),
                name: 'search_knowledge',
              },
              id: 'search-call-1',
              type: 'function',
            },
          ],
        },
      },
    ],
    id: 'fact-checker-tool-request',
    model: 'configured-provider-model',
    usage: { completion_tokens: 20, prompt_tokens: 100, total_tokens: 120 },
  };
}

function providerOutput(output: unknown) {
  return {
    choices: [
      {
        finish_reason: 'stop',
        index: 0,
        message: { content: JSON.stringify(output), role: 'assistant' },
      },
    ],
    id: 'fact-checker-output-request',
    model: 'configured-provider-model',
    usage: { completion_tokens: 180, prompt_tokens: 500, total_tokens: 680 },
  };
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

function json(outgoing: ServerResponse, value: unknown): void {
  outgoing.writeHead(200, { 'Content-Type': 'application/json' });
  outgoing.end(JSON.stringify(value));
}
