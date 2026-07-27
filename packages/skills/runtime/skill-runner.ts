import type {
  JsonObject,
  JsonValue,
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
  readonly toolResults: readonly SkillToolResult[];
  readonly usages: readonly ModelUsage[];
}

export interface SkillToolResult {
  readonly name: string;
  readonly output: JsonValue;
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
    const capabilities = this.adapter.capabilities();
    if (!capabilities.jsonSchema && !capabilities.jsonMode) {
      throw new SkillRuntimeError(
        'SKILL_MODEL_CAPABILITY_UNAVAILABLE',
        'Skill execution requires JSON Schema or JSON mode',
      );
    }
    const messages: ModelMessage[] = [
      ...input.messages,
      ...(capabilities.jsonSchema ? [] : [jsonModeSchemaMessage(input.outputSchema)]),
    ];
    let toolCallCount = 0;
    const toolResults: SkillToolResult[] = [];

    for (let round = 0; ; round += 1) {
      const result = await this.generate(input, messages, definitions);
      await input.recordUsage(result.usage);
      usages.push(result.usage);
      const calls = result.message.toolCalls ?? [];
      if (calls.length === 0) {
        return this.parseOrRepair<TInput, TOutput>(
          input,
          messages,
          result,
          usages,
          toolCallCount,
          toolResults,
        );
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
        toolResults.push(Object.freeze({ name: call.name, output }));
        toolCallCount += 1;
      }
    }
  }

  private generate<TInput>(
    input: SkillRunInput<TInput>,
    messages: readonly ModelMessage[],
    tools: ReturnType<ToolRegistry['definitions']>,
  ): Promise<ModelResult> {
    const capabilities = this.adapter.capabilities();
    if (!capabilities.jsonSchema && !capabilities.jsonMode) {
      throw new SkillRuntimeError(
        'SKILL_MODEL_CAPABILITY_UNAVAILABLE',
        'Skill execution requires JSON Schema or JSON mode',
      );
    }
    return this.adapter.generate({
      maxOutputTokens: input.maxOutputTokens,
      messages,
      requestId: input.context.requestId,
      responseFormat: capabilities.jsonSchema
        ? {
            name: `${input.context.skillName.replaceAll('-', '_')}_output`,
            schema: input.outputSchema,
            strict: true,
            type: 'json_schema',
          }
        : { type: 'json_object' },
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
    toolResults: readonly SkillToolResult[],
  ): Promise<SkillRunResult<TOutput>> {
    const firstCheck = parseAndCheck<TOutput>(this.schemas, input.outputSchema, first);
    if (firstCheck.valid) return result(firstCheck.value, usages, 0, toolCallCount, toolResults);

    const repairMessages: ModelMessage[] = [
      ...messages,
      ...(firstCheck.kind === 'schema' ? [first.message] : []),
      {
        content: JSON.stringify({
          failure_kind: firstCheck.kind,
          finish_reason: first.finishReason,
          instruction: repairInstruction(firstCheck.kind, first.finishReason),
          invalid_paths: firstCheck.paths,
          required_root_fields: requiredRootFields(input.outputSchema),
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
        invalidOutputMessage(repairedCheck, repaired),
        repairedCheck.paths,
      );
    }
    return result(repairedCheck.value, usages, 1, toolCallCount, toolResults);
  }
}

type Parsed<T> =
  | {
      readonly kind: 'empty' | 'invalid_json' | 'schema';
      readonly paths: readonly string[];
      readonly valid: false;
    }
  | { readonly valid: true; readonly value: T };

function parseAndCheck<T>(
  schemas: SchemaGuard,
  schema: JsonObject,
  result: ModelResult,
): Parsed<T> {
  const content = result.message.content;
  if (!content) return { kind: 'empty', paths: Object.freeze(['$']), valid: false };
  const candidate = parseModelJson(content);
  if (!candidate.valid) {
    return { kind: 'invalid_json', paths: Object.freeze(['$']), valid: false };
  }
  const parsed = candidate.value;
  const check = schemas.check<T>(schema, parsed);
  return check.valid
    ? { valid: true, value: check.value as T }
    : { kind: 'schema', paths: check.paths, valid: false };
}

type ParsedJson = { readonly valid: false } | { readonly valid: true; readonly value: unknown };

function parseModelJson(content: string): ParsedJson {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const unfenced = stripJsonFence(trimmed);
  if (unfenced !== trimmed) candidates.push(unfenced);
  const extracted = extractFirstJsonObject(unfenced);
  if (extracted && !candidates.includes(extracted)) candidates.push(extracted);

  for (const candidate of candidates) {
    try {
      return { valid: true, value: JSON.parse(candidate) as unknown };
    } catch {
      // Try the next deterministic representation.
    }
  }
  return { valid: false };
}

function stripJsonFence(value: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(value);
  return match?.[1]?.trim() ?? value;
}

function extractFirstJsonObject(value: string): string | undefined {
  const start = value.indexOf('{');
  if (start < 0 || value.trimStart().startsWith('[')) return undefined;
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return undefined;
}

function repairInstruction(
  kind: Extract<Parsed<never>, { readonly valid: false }>['kind'],
  finishReason: ModelResult['finishReason'],
): string {
  if (finishReason === 'length') {
    return 'The previous response was truncated. Regenerate one shorter but complete JSON object. Preserve required article substance, use concise metadata, and do not invent facts, identifiers, citations, or missing values.';
  }
  if (kind === 'empty' || kind === 'invalid_json') {
    return 'The previous response was empty or malformed. Regenerate one complete JSON object only. Return no Markdown or commentary, and do not invent facts, identifiers, citations, or missing values.';
  }
  return 'Return corrected JSON only. Fix every invalid path without inventing facts, identifiers, citations, or missing values. Remove unsupported optional entries when that is the only schema-valid correction.';
}

function requiredRootFields(schema: JsonObject): readonly string[] {
  return Array.isArray(schema['required'])
    ? schema['required'].filter((value): value is string => typeof value === 'string')
    : [];
}

function invalidOutputMessage(
  check: Extract<Parsed<never>, { readonly valid: false }>,
  result: ModelResult,
): string {
  return `Skill output failed schema validation after one repair (failure_kind=${check.kind}, finish_reason=${result.finishReason}, content_chars=${result.message.content?.length ?? 0})`;
}

function result<T>(
  output: T,
  usages: readonly ModelUsage[],
  schemaRepairAttempts: 0 | 1,
  toolCallCount: number,
  toolResults: readonly SkillToolResult[],
): SkillRunResult<T> {
  return Object.freeze({
    output,
    schemaRepairAttempts,
    toolCallCount,
    toolResults: Object.freeze([...toolResults]),
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

function jsonModeSchemaMessage(outputSchema: JsonObject): ModelMessage {
  return {
    content: JSON.stringify({
      instruction:
        'Return exactly one JSON object that validates against output_schema. Include every required field, omit undeclared fields, and return no Markdown or commentary.',
      output_schema: outputSchema,
    }),
    role: 'user',
  };
}
