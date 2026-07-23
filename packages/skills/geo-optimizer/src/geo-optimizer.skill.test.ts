import { MockModelAdapter, type JsonObject } from '@geo-content-os/adapter-model';
import { DeepSeekModelAdapter } from '@geo-content-os/adapter-model-deepseek';
import {
  GET_PLATFORM_RULES_TOOL,
  GET_STRATEGY_VERSION_TOOL,
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

import { GEO_OPTIMIZER_CONTRACT_V1 } from '../contracts/v1.0.0/index.js';
import { GeoOptimizerSkill } from './geo-optimizer.skill.js';

const closers: Array<() => Promise<void>> = [];
const fixture = GEO_OPTIMIZER_CONTRACT_V1.fewShots[0]!;
const context = createSkillContext({
  inputHash: 'c'.repeat(64),
  modelKey: 'flash',
  projectId: '40000000-0000-4000-8000-000000000067',
  promptVersionId: 'a0000000-0000-4000-8000-000000000067',
  requestId: 'request-geo-optimizer-0067',
  runId: '90000000-0000-4000-8000-000000000067',
  skillName: 'geo-optimizer',
  skillVersion: '1.0.0',
  tenantId: 'b0000000-0000-4000-8000-000000000067',
  workspaceId: 'd0000000-0000-4000-8000-000000000067',
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('GeoOptimizerSkill', () => {
  it('uses the frozen tool whitelist with the Mock Adapter', async () => {
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [strategyCall(), rulesCall(), { text: JSON.stringify(fixture.output) }],
    });

    const result = await skill(adapter).run({
      context,
      input: fixture.input,
      recordUsage: () => undefined,
    });

    expect(result).toMatchObject({ output: fixture.output, toolCallCount: 2 });
    expect(result.toolResults.map((item) => item.name)).toEqual([
      'get_strategy_version',
      'get_platform_rules',
    ]);
  });

  it('rejects citation loss even when the output matches the JSON Schema', async () => {
    const output = {
      ...fixture.output,
      data: {
        ...fixture.output.data,
        optimized_content: {
          ...fixture.output.data.optimized_content,
          citation_map: [],
        },
      },
    };
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });
    await expect(
      skill(adapter).run({ context, input: fixture.input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it('rejects removal of required evidence from the output envelope', async () => {
    const output = { ...fixture.output, citations: [] };
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });
    await expect(
      skill(adapter).run({ context, input: fixture.input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it('rejects a changed locked block', async () => {
    const boundary = GEO_OPTIMIZER_CONTRACT_V1.fewShots[2]!;
    const output = {
      ...boundary.output,
      data: {
        ...boundary.output.data,
        optimized_content: {
          ...boundary.output.data.optimized_content,
          blocks: boundary.output.data.optimized_content.blocks.map((block) =>
            block.block_key === 'legal' ? { ...block, text: 'Changed legal text.' } : block,
          ),
        },
      },
    };
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });
    await expect(
      skill(adapter).run({ context, input: boundary.input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it('accepts a blocked unsafe proposal only when original content is returned', async () => {
    const unsafe = GEO_OPTIMIZER_CONTRACT_V1.fewShots[1]!;
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(unsafe.output) }],
    });
    await expect(
      skill(adapter).run({ context, input: unsafe.input, recordUsage: () => undefined }),
    ).resolves.toMatchObject({
      output: { blockers: [{ code: 'CITATION_LOSS' }], status: 'failed' },
    });
  });

  it('runs through the real DeepSeek Adapter using JSON mode and authorized tools', async () => {
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
              message: { content: JSON.stringify(fixture.output), role: 'assistant' },
            },
          ],
          id: 'geo-optimizer-provider-request',
          model: 'configured-provider-model',
          usage: { completion_tokens: 160, prompt_tokens: 430, total_tokens: 590 },
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
    ).resolves.toMatchObject({ output: { skill_name: 'geo-optimizer' } });
    expect(requestBody).toMatchObject({
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });
    expect(requestBody?.['tools']).toHaveLength(3);
  });
});

function strategyCall() {
  return {
    toolCalls: [
      {
        arguments: { brand_profile_id: '40000000-0000-4000-8000-000000000067' },
        id: 'strategy-call-1',
        name: 'get_strategy_version',
      },
    ],
  };
}

function rulesCall() {
  return {
    toolCalls: [
      {
        arguments: {
          platform_code: 'official_site',
          version_id: '50000000-0000-4000-8000-000000000067',
        },
        id: 'rules-call-1',
        name: 'get_platform_rules',
      },
    ],
  };
}

function skill(adapter: ConstructorParameters<typeof SkillRunner>[0]): GeoOptimizerSkill {
  const schemas = new SchemaGuard();
  return new GeoOptimizerSkill(
    new SkillRunner(
      adapter,
      schemas,
      new ToolRegistry(
        [
          tool(GET_STRATEGY_VERSION_TOOL, () => ({ profile: {}, version: 2 })),
          tool(GET_PLATFORM_RULES_TOOL, () => ({ rules: {}, version: 1 })),
          tool(SEARCH_KNOWLEDGE_TOOL, () => []),
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
    allowedSkills: ['geo-optimizer'] as const,
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
