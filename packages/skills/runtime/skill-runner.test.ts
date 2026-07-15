import {
  MockModelAdapter,
  type JsonObject,
  type JsonValue,
  type ModelRequest,
  type ModelResult,
  type ModelToolCall,
} from '@geo-content-os/adapter-model';
import { describe, expect, it, vi } from 'vitest';

import {
  createSkillContext,
  SchemaGuard,
  SkillRunner,
  ToolRegistry,
  type SkillContext,
  type SkillTool,
} from './index.js';

const INPUT_SCHEMA: JsonObject = {
  additionalProperties: false,
  properties: { question: { minLength: 1, type: 'string' } },
  required: ['question'],
  type: 'object',
};

const OUTPUT_SCHEMA: JsonObject = {
  additionalProperties: false,
  properties: { answer: { minLength: 1, type: 'string' } },
  required: ['answer'],
  type: 'object',
};

describe('SkillContext', () => {
  it('validates and freezes server-owned scope and trace fields', () => {
    const context = createSkillContext(contextInput());

    expect(Object.isFrozen(context)).toBe(true);
    expect(context.skillName).toBe('content-writer');
    expect(() => createSkillContext(contextInput({ inputHash: 'invalid' }))).toThrowError(
      expect.objectContaining({ code: 'SKILL_CONTEXT_INVALID' }),
    );
  });
});

describe('SchemaGuard', () => {
  it('enforces Draft 2020-12 formats and additionalProperties', () => {
    const schema: JsonObject = {
      additionalProperties: false,
      properties: { id: { format: 'uuid', type: 'string' } },
      required: ['id'],
      type: 'object',
    };
    const guard = new SchemaGuard();

    expect(guard.check(schema, { id: '11111111-1111-4111-8111-111111111111' }).valid).toBe(true);
    expect(guard.check(schema, { extra: true, id: 'not-a-uuid' })).toMatchObject({
      paths: ['/extra', '/id'],
      valid: false,
    });
  });
});

describe('ToolRegistry', () => {
  it('rejects tenant_id in model-visible tool schemas', () => {
    expect(
      () =>
        new ToolRegistry(
          [
            tool({
              inputSchema: {
                properties: { tenant_id: { type: 'string' } },
                type: 'object',
              },
            }),
          ],
          new SchemaGuard(),
        ),
    ).toThrowError('must not expose tenant_id');
  });

  it('overrides workspace and project scope before validation and execution', async () => {
    const execute = vi.fn<(arguments_: JsonObject, context: SkillContext) => JsonValue>(() => ({
      hits: [],
    }));
    const registry = new ToolRegistry([searchTool(execute)], new SchemaGuard());
    const context = createSkillContext(contextInput({ skillName: 'fact-checker' }));

    await registry.execute(
      'fact-checker',
      toolCall({
        arguments: {
          project_id: '99999999-9999-4999-8999-999999999999',
          query: 'verified fact',
          workspace_id: '88888888-8888-4888-8888-888888888888',
        },
      }),
      context,
    );

    expect(execute).toHaveBeenCalledWith(
      {
        project_id: context.projectId,
        query: 'verified fact',
        workspace_id: context.workspaceId,
      },
      context,
      undefined,
    );
  });
});

describe('SkillRunner', () => {
  it('validates input before model execution', async () => {
    const runner = createRunner([{ text: '{"answer":"unused"}' }]);

    await expect(runner.run(runInput({ input: {} }))).rejects.toMatchObject({
      code: 'SKILL_INPUT_INVALID',
      paths: ['/question'],
    });
  });

  it('returns schema-valid output and exact provider usage', async () => {
    const runner = createRunner([{ text: '{"answer":"grounded"}' }]);

    const result = await runner.run<{ question: string }, { answer: string }>(runInput());

    expect(result.output).toEqual({ answer: 'grounded' });
    expect(result).toMatchObject({ schemaRepairAttempts: 0, toolCallCount: 0 });
    expect(result.usages).toHaveLength(1);
    expect(result.usages[0]?.modelKey).toBe('flash');
  });

  it('falls back to JSON mode when an Adapter cannot enforce JSON Schema', async () => {
    const adapter = new MockModelAdapter({
      capabilities: { jsonMode: true, jsonSchema: false },
      modelKey: 'flash',
      responses: [{ text: '{"answer":"json-mode"}' }],
    });
    const runner = new SkillRunner(
      adapter,
      new SchemaGuard(),
      new ToolRegistry([], new SchemaGuard()),
    );

    await expect(runner.run(runInput())).resolves.toMatchObject({
      output: { answer: 'json-mode' },
    });
  });

  it('rejects an Adapter without structured JSON capabilities', async () => {
    const adapter = new MockModelAdapter({
      capabilities: { jsonMode: false, jsonSchema: false },
      modelKey: 'flash',
      responses: [{ text: '{"answer":"unused"}' }],
    });
    const runner = new SkillRunner(
      adapter,
      new SchemaGuard(),
      new ToolRegistry([], new SchemaGuard()),
    );

    await expect(runner.run(runInput())).rejects.toMatchObject({
      code: 'SKILL_MODEL_CAPABILITY_UNAVAILABLE',
    });
  });

  it('performs exactly one schema repair using invalid paths', async () => {
    const runner = createRunner([{ text: '{}' }, { text: '{"answer":"repaired"}' }]);

    const result = await runner.run<{ question: string }, { answer: string }>(runInput());

    expect(result.output).toEqual({ answer: 'repaired' });
    expect(result.schemaRepairAttempts).toBe(1);
    expect(result.usages).toHaveLength(2);
  });

  it('fails after the single schema repair is still invalid', async () => {
    const runner = createRunner([{ text: '{}' }, { text: '{}' }]);
    const recordUsage = vi.fn();

    await expect(runner.run(runInput({ recordUsage }))).rejects.toMatchObject({
      code: 'SKILL_OUTPUT_INVALID',
      paths: ['/answer'],
    });
    expect(recordUsage).toHaveBeenCalledTimes(2);
  });

  it('executes an allowed tool and returns the subsequent structured result', async () => {
    const execute = vi.fn<(arguments_: JsonObject) => JsonValue>(() => ({ hits: ['chunk-1'] }));
    const call = toolCall();
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ toolCalls: [call] }, { text: '{"answer":"from evidence"}' }],
    });
    const schemas = new SchemaGuard();
    const runner = new SkillRunner(
      adapter,
      schemas,
      new ToolRegistry([searchTool(execute)], schemas),
    );

    const result = await runner.run(
      runInput({
        context: createSkillContext(contextInput({ skillName: 'fact-checker' })),
        toolNames: ['search_knowledge'],
      }),
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ schemaRepairAttempts: 0, toolCallCount: 1 });
    expect(result.toolResults).toEqual([
      { name: 'search_knowledge', output: { hits: ['chunk-1'] } },
    ]);
    expect(result.usages).toHaveLength(2);
  });

  it('blocks tools that are not allowed for the current skill', async () => {
    const schemas = new SchemaGuard();
    const runner = new SkillRunner(
      new MockModelAdapter({ modelKey: 'flash' }),
      schemas,
      new ToolRegistry([searchTool()], schemas),
    );

    await expect(runner.run(runInput({ toolNames: ['search_knowledge'] }))).rejects.toMatchObject({
      code: 'SKILL_TOOL_FORBIDDEN',
    });
  });

  it('blocks a globally allowed tool that was not enabled for this run', async () => {
    const execute = vi.fn<SkillTool['execute']>(() => ({ created: true }));
    const adapter = new UnlistedToolMockAdapter({
      modelKey: 'flash',
      responses: [
        {
          toolCalls: [toolCall({ arguments: {}, name: 'request_human_review' })],
        },
      ],
    });
    const schemas = new SchemaGuard();
    const runner = new SkillRunner(
      adapter,
      schemas,
      new ToolRegistry(
        [
          searchTool(),
          tool({
            allowedSkills: ['fact-checker'],
            execute,
            inputSchema: { additionalProperties: false, type: 'object' },
            name: 'request_human_review',
          }),
        ],
        schemas,
      ),
    );

    await expect(
      runner.run(
        runInput({
          context: createSkillContext(contextInput({ skillName: 'fact-checker' })),
          toolNames: ['search_knowledge'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'SKILL_TOOL_FORBIDDEN' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops repeated tool calls at the fixed lifecycle limit', async () => {
    const calls = Array.from({ length: 5 }, (_, index) => ({
      toolCalls: [toolCall({ id: `call-${index + 1}` })],
    }));
    const adapter = new MockModelAdapter({ modelKey: 'flash', responses: calls });
    const schemas = new SchemaGuard();
    const runner = new SkillRunner(adapter, schemas, new ToolRegistry([searchTool()], schemas));

    await expect(
      runner.run(
        runInput({
          context: createSkillContext(contextInput({ skillName: 'fact-checker' })),
          toolNames: ['search_knowledge'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'SKILL_TOOL_LIMIT_EXCEEDED' });
  });
});

function createRunner(
  responses: NonNullable<
    NonNullable<ConstructorParameters<typeof MockModelAdapter>[0]>['responses']
  >,
): SkillRunner {
  const schemas = new SchemaGuard();
  return new SkillRunner(
    new MockModelAdapter({ modelKey: 'flash', responses }),
    schemas,
    new ToolRegistry([], schemas),
  );
}

function runInput(overrides: Record<string, unknown> = {}) {
  return {
    context: createSkillContext(contextInput()),
    input: { question: 'What is grounded?' },
    inputSchema: INPUT_SCHEMA,
    maxOutputTokens: 200,
    messages: [
      { content: 'Return only schema-valid JSON.', role: 'system' as const },
      { content: 'What is grounded?', role: 'user' as const },
    ],
    outputSchema: OUTPUT_SCHEMA,
    recordUsage: () => undefined,
    ...overrides,
  };
}

function contextInput(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    inputHash: 'a'.repeat(64),
    modelKey: 'flash',
    projectId: '33333333-3333-4333-8333-333333333333',
    promptVersionId: '44444444-4444-4444-8444-444444444444',
    requestId: 'request-00000001',
    runId: '55555555-5555-4555-8555-555555555555',
    skillName: 'content-writer',
    skillVersion: '1.0.0',
    tenantId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    ...overrides,
  };
}

function searchTool(execute: SkillTool['execute'] = () => ({ hits: [] })): SkillTool {
  return tool({
    allowedSkills: ['fact-checker'],
    execute,
    inputSchema: {
      additionalProperties: false,
      properties: {
        project_id: { format: 'uuid', type: ['string', 'null'] },
        query: { minLength: 2, type: 'string' },
        workspace_id: { format: 'uuid', type: 'string' },
      },
      required: ['query', 'workspace_id'],
      type: 'object',
    },
    name: 'search_knowledge',
  });
}

function tool(overrides: Partial<SkillTool> = {}): SkillTool {
  return {
    allowedSkills: ['content-writer'],
    description: 'Search current scoped knowledge',
    execute: () => ({ hits: [] }),
    inputSchema: { type: 'object' },
    name: 'search_knowledge',
    ...overrides,
  };
}

function toolCall(overrides: Partial<ModelToolCall> = {}): ModelToolCall {
  return {
    arguments: {
      project_id: '99999999-9999-4999-8999-999999999999',
      query: 'verified fact',
      workspace_id: '88888888-8888-4888-8888-888888888888',
    },
    id: 'call-1',
    name: 'search_knowledge',
    ...overrides,
  };
}

class UnlistedToolMockAdapter extends MockModelAdapter {
  public override generate(input: ModelRequest): Promise<ModelResult> {
    return super.generate({
      ...input,
      toolChoice: 'auto',
      tools: [
        ...(input.tools ?? []),
        {
          description: 'Hidden tool returned by a non-conforming provider',
          inputSchema: { additionalProperties: false, type: 'object' },
          name: 'request_human_review',
        },
      ],
    });
  }
}
