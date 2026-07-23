import type {
  JsonObject,
  JsonValue,
  ModelToolCall,
  ModelToolDefinition,
} from '@geo-content-os/adapter-model';

import type { SchemaGuard } from './schema-guard.js';
import { SKILL_NAMES, type SkillContext, type SkillName } from './skill-context.js';
import { SkillRuntimeError } from './skill-runtime.errors.js';

export interface SkillTool {
  readonly allowedSkills: readonly SkillName[];
  readonly description: string;
  readonly execute: (
    arguments_: JsonObject,
    context: SkillContext,
    signal?: AbortSignal,
  ) => JsonValue | Promise<JsonValue>;
  readonly inputSchema: JsonObject;
  readonly name: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, SkillTool>();

  public constructor(
    tools: readonly SkillTool[],
    private readonly schemas: SchemaGuard,
  ) {
    for (const tool of tools) {
      if (
        !identifier(tool.name) ||
        !tool.description.trim() ||
        this.tools.has(tool.name) ||
        tool.allowedSkills.length === 0 ||
        new Set(tool.allowedSkills).size !== tool.allowedSkills.length ||
        tool.allowedSkills.some((skill) => !SKILL_NAMES.includes(skill))
      ) {
        throw new TypeError('Skill tool registration is invalid or duplicated');
      }
      const inputSchema = freezeJson(structuredClone(tool.inputSchema)) as JsonObject;
      if (exposesTenantId(inputSchema)) {
        throw new TypeError('Skill tool schemas must not expose tenant_id');
      }
      this.tools.set(
        tool.name,
        Object.freeze({
          ...tool,
          allowedSkills: Object.freeze([...tool.allowedSkills]),
          inputSchema,
        }),
      );
    }
  }

  public definitions(
    skillName: SkillName,
    names: readonly string[],
  ): readonly ModelToolDefinition[] {
    const uniqueNames = new Set(names);
    if (uniqueNames.size !== names.length) throw new TypeError('Skill tool names are duplicated');
    return Object.freeze(
      names.map((name) => {
        const tool = this.requireAllowed(name, skillName);
        return Object.freeze({
          description: tool.description,
          inputSchema: tool.inputSchema,
          name: tool.name,
        });
      }),
    );
  }

  public async execute(
    skillName: SkillName,
    call: ModelToolCall,
    context: SkillContext,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const tool = this.requireAllowed(call.name, skillName);
    const arguments_ = applyServerScope(call.arguments, tool.inputSchema, context);
    this.schemas.assert<JsonObject>(
      tool.inputSchema,
      arguments_,
      'SKILL_TOOL_ARGUMENTS_INVALID',
      'Skill tool arguments failed schema validation',
    );
    try {
      return await tool.execute(arguments_, context, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SkillRuntimeError(
        'SKILL_TOOL_EXECUTION_FAILED',
        `Skill tool execution failed: ${tool.name}`,
        [],
        { cause: error },
      );
    }
  }

  private requireAllowed(name: string, skillName: SkillName): SkillTool {
    const tool = this.tools.get(name);
    if (!tool) throw new SkillRuntimeError('SKILL_TOOL_NOT_FOUND', 'Skill tool is not registered');
    if (!tool.allowedSkills.includes(skillName)) {
      throw new SkillRuntimeError('SKILL_TOOL_FORBIDDEN', 'Skill is not allowed to use this tool');
    }
    return tool;
  }
}

function applyServerScope(
  provided: JsonObject,
  schema: JsonObject,
  context: SkillContext,
): JsonObject {
  const scoped: Record<string, JsonValue> = { ...provided };
  delete scoped['tenant_id'];
  const properties = schemaProperties(schema);
  if (properties && Object.hasOwn(properties, 'workspace_id')) {
    scoped['workspace_id'] = context.workspaceId;
  }
  if (properties && Object.hasOwn(properties, 'project_id')) {
    scoped['project_id'] = context.projectId;
  }
  return Object.freeze(scoped);
}

function schemaProperties(schema: JsonObject): JsonObject | undefined {
  const properties = schema['properties'];
  return isJsonObject(properties) ? properties : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identifier(value: string): boolean {
  return value.length <= 80 && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(value);
}

function exposesTenantId(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(exposesTenantId);
  if (!isJsonObject(value)) return false;
  const properties = schemaProperties(value);
  if (properties && Object.hasOwn(properties, 'tenant_id')) return true;
  return Object.values(value).some(exposesTenantId);
}

function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (isJsonObject(value)) {
    const frozen: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) frozen[key] = freezeJson(child);
    return Object.freeze(frozen);
  }
  return value;
}
