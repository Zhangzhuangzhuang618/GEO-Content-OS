import { MockModelAdapter } from '@geo-content-os/adapter-model';
import { DeepSeekModelAdapter } from '@geo-content-os/adapter-model-deepseek';
import {
  createSkillContext,
  SchemaGuard,
  SkillRunner,
  ToolRegistry,
} from '@geo-content-os/skills/runtime';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MATERIAL_PARSER_CONTRACT_V1 } from '../contracts/v1.0.0/index.js';
import { MaterialParserSkill } from './material-parser.skill.js';

const closers: Array<() => Promise<void>> = [];
const fixture = MATERIAL_PARSER_CONTRACT_V1.fewShots[0]!;
const context = createSkillContext({
  inputHash: 'a'.repeat(64),
  modelKey: 'flash',
  projectId: null,
  promptVersionId: '33333333-3333-4333-8333-333333333333',
  requestId: 'request-material-parser-0001',
  runId: '22222222-2222-4222-8222-222222222222',
  skillName: 'material-parser',
  skillVersion: '1.0.0',
  tenantId: '44444444-4444-4444-8444-444444444444',
  workspaceId: '55555555-5555-4555-8555-555555555555',
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('MaterialParserSkill', () => {
  it('runs the frozen Prompt and schema with the Mock Model Adapter', async () => {
    const recordUsage = vi.fn();
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(fixture.output) }],
    });

    const result = await skill(adapter).run({ context, input: fixture.input, recordUsage });

    expect(result.output).toEqual(fixture.output);
    expect(result).toMatchObject({ schemaRepairAttempts: 0, toolCallCount: 0 });
    expect(recordUsage).toHaveBeenCalledOnce();
  });

  it('rejects forged trace fields and out-of-range fact references', async () => {
    const forged = {
      ...fixture.output,
      data: {
        ...fixture.output.data,
        candidate_facts: [{ ...fixture.output.data.candidate_facts[0]!, source_chunk_no: 9 }],
      },
    };
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(forged) }],
    });

    await expect(
      skill(adapter).run({ context, input: fixture.input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it('runs through the real DeepSeek Adapter using JSON mode and no tools', async () => {
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
          id: 'material-parser-provider-request',
          model: 'configured-provider-model',
          usage: { completion_tokens: 80, prompt_tokens: 120, total_tokens: 200 },
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
    ).resolves.toMatchObject({ output: { skill_name: 'material-parser' } });
    expect(requestBody).toMatchObject({
      response_format: { type: 'json_object' },
      stream: false,
      temperature: 0,
    });
    expect(requestBody).not.toHaveProperty('tools');
  });
});

function skill(adapter: ConstructorParameters<typeof SkillRunner>[0]): MaterialParserSkill {
  const schemas = new SchemaGuard();
  return new MaterialParserSkill(new SkillRunner(adapter, schemas, new ToolRegistry([], schemas)));
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
