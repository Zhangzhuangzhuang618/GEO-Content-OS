import type {
  JsonObject,
  ModelAdapter,
  ModelMessage,
  ModelResult,
  ModelUsage,
} from '@geo-content-os/adapter-model';

import type { SchemaGuard } from './schema-guard.js';
import type { SkillContext } from './skill-context.js';
import { SkillRuntimeError } from './skill-runtime.errors.js';
import type { ToolRegistry } from './tool-registry.js';

const MAX_TOOL_ROUNDS = 4;

export interface SkillRunInput<TInput> {
  readonly context: SkillContext;
  readonly input: TInput;
  readonly inputSchema: JsonObject;
  readonly maxOutputTokens: number;
  readonly messages: readonly ModelMessage[];
  readonly outputSchema: JsonObject;
  readonly recordUsage: (usage: ModelUsage) => Promise<void> | void;
  readonly signal?: AbortSignal;
  readonly temperature?: number;
  readonly toolNames?: readonly string[];
}

export interface SkillRunResult<TOutput> {
  readonly output: TOutput;
  readonly schemaRepairAttempts: 0 | 1;
  readonly toolCallCount: number;
  readonly usages: readonly ModelUsage[];
}

export class SkillRunner {
  public constructor(
    private readonly adapter: ModelAdapter,
    private readonly schemas: SchemaGuard,
    private readonly tools: ToolRegistry,
  ) {}

  public async run<TInput, TOutput>(
    input: SkillRunInput<TInput>,
  ): Promise<SkillRunResult<TOutput>> {
    if (input.context.modelKey !== this.adapter.modelKey) {
      throw new SkillRuntimeError(
        'SKILL_MODEL_MISMATCH',
        'Skill context model does not match the configured adapter',
      );
    }
    this.schemas.assert<TInput>(
      input.inputSchema,
      input.input,
      'SKILL_INPUT_INVALID',
      'Skill input failed schema validation',
    );
    const definitions = this.tools.definitions(input.context.skillName, input.toolNames ?? []);
    const allowedToolNames = new Set(definitions.map((definition) => definition.name));
    const usages: ModelUsage[] = [];
    const messages: ModelMessage[] = [...input.messages];
    let toolCallCount = 0;

    for (let round = 0; ; round += 1) {
      const result = await this.generate(input, messages, definitions);
      await input.recordUsage(result.usage);
      usages.push(result.usage);
      const calls = result.message.toolCalls ?? [];
      if (calls.length === 0) {
        return this.parseOrRepair<TInput, TOutput>(input, messages, result, usages, toolCallCount);
      }
      if (round >= MAX_TOOL_ROUNDS) {
        throw new SkillRuntimeError(
          'SKILL_TOOL_LIMIT_EXCEEDED',
          'Skill exceeded the maximum tool call rounds',
        );
      }
      assertUniqueToolCallIds(calls.map((call) => call.id));
      messages.push(result.message);
      for (const call of calls) {
        if (!allowedToolNames.has(call.name)) {
          throw new SkillRuntimeError(
            'SKILL_TOOL_FORBIDDEN',
            'Model requested a tool outside this skill run whitelist',
          );
        }
        const output = await this.tools.execute(
          input.context.skillName,
          call,
          input.context,
          input.signal,
        );
        messages.push({ content: JSON.stringify(output), role: 'tool', toolCallId: call.id });
        toolCallCount += 1;
      }
    }
  }

  private generate<TInput>(
    input: SkillRunInput<TInput>,
    messages: readonly ModelMessage[],
    tools: ReturnType<ToolRegistry['definitions']>,
  ): Promise<ModelResult> {
    return this.adapter.generate({
      maxOutputTokens: input.maxOutputTokens,
      messages,
      requestId: input.context.requestId,
      responseFormat: {
        name: `${input.context.skillName.replaceAll('-', '_')}_output`,
        schema: input.outputSchema,
        strict: true,
        type: 'json_schema',
      },
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(tools.length > 0 ? { toolChoice: 'auto' as const, tools } : {}),
    });
  }

  private async parseOrRepair<TInput, TOutput>(
    input: SkillRunInput<TInput>,
    messages: readonly ModelMessage[],
    first: ModelResult,
    usages: ModelUsage[],
    toolCallCount: number,
  ): Promise<SkillRunResult<TOutput>> {
    const firstCheck = parseAndCheck<TOutput>(this.schemas, input.outputSchema, first);
    if (firstCheck.valid) return result(firstCheck.value, usages, 0, toolCallCount);

    const repairMessages: ModelMessage[] = [
      ...messages,
      first.message,
      {
        content: JSON.stringify({
          instruction: 'Return corrected JSON only.',
          invalid_paths: firstCheck.paths,
        }),
        role: 'user',
      },
    ];
    const repaired = await this.generate(input, repairMessages, []);
    await input.recordUsage(repaired.usage);
    usages.push(repaired.usage);
    if ((repaired.message.toolCalls?.length ?? 0) > 0) {
      throw new SkillRuntimeError(
        'SKILL_OUTPUT_INVALID',
        'Skill schema repair returned a tool call',
        firstCheck.paths,
      );
    }
    const repairedCheck = parseAndCheck<TOutput>(this.schemas, input.outputSchema, repaired);
    if (!repairedCheck.valid) {
      throw new SkillRuntimeError(
        'SKILL_OUTPUT_INVALID',
        'Skill output failed schema validation after one repair',
        repairedCheck.paths,
      );
    }
    return result(repairedCheck.value, usages, 1, toolCallCount);
  }
}

type Parsed<T> =
  | { readonly paths: readonly string[]; readonly valid: false }
  | { readonly valid: true; readonly value: T };

function parseAndCheck<T>(
  schemas: SchemaGuard,
  schema: JsonObject,
  result: ModelResult,
): Parsed<T> {
  const content = result.message.content;
  if (!content) return { paths: Object.freeze(['$']), valid: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { paths: Object.freeze(['$']), valid: false };
  }
  const check = schemas.check<T>(schema, parsed);
  return check.valid
    ? { valid: true, value: check.value as T }
    : { paths: check.paths, valid: false };
}

function result<T>(
  output: T,
  usages: readonly ModelUsage[],
  schemaRepairAttempts: 0 | 1,
  toolCallCount: number,
): SkillRunResult<T> {
  return Object.freeze({
    output,
    schemaRepairAttempts,
    toolCallCount,
    usages: Object.freeze([...usages]),
  });
}

function assertUniqueToolCallIds(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length || ids.some((id) => !id.trim())) {
    throw new SkillRuntimeError(
      'SKILL_TOOL_ARGUMENTS_INVALID',
      'Skill model returned invalid tool call IDs',
    );
  }
}
