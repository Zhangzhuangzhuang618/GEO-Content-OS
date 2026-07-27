import type { ModelAdapter, ModelUsage } from '@geo-content-os/adapter-model';
import {
  GET_PLATFORM_RULES_TOOL,
  GET_STRATEGY_VERSION_TOOL,
  type ContentWriterContent,
  type ContentWriterData,
  type ContentWriterOutput,
} from '@geo-content-os/contracts/skills';
import {
  assessContentWriterData,
  ContentWriterSkill,
  type ContentWriterPublishedPrompt,
  type ContentWriterRevision,
} from '@geo-content-os/skills/content-writer';
import {
  createSkillContext,
  SchemaGuard,
  SkillRunner,
  SkillRuntimeError,
  type SkillTool,
  ToolRegistry,
} from '@geo-content-os/skills/runtime';
import type postgres from 'postgres';

import { GenerationWorkerError } from './generation.errors.js';
import type {
  ContentWriterPort,
  ContentWriterRunContext,
  GeneratedContent,
  JsonObject,
} from './generation.types.js';

interface CachedRun {
  readonly output: Promise<ContentWriterOutput>;
  readonly remaining: Set<string>;
}

export class RuntimeContentWriter implements ContentWriterPort {
  private readonly runs = new Map<string, CachedRun>();

  public constructor(
    private readonly client: postgres.Sql,
    private readonly adapters: ReadonlyMap<string, ModelAdapter>,
    private readonly recordUsage: (
      context: ContentWriterRunContext,
      usage: ModelUsage,
    ) => Promise<void>,
    private readonly promptLoader?: (
      context: ContentWriterRunContext,
    ) => Promise<ContentWriterPublishedPrompt>,
  ) {}

  public async generateMaster(input: {
    readonly context: ContentWriterRunContext;
    readonly requestId: string;
    readonly signal?: AbortSignal;
    readonly writerInput: JsonObject;
  }): Promise<GeneratedContent> {
    const cached = this.start(input);
    try {
      const output = await cached.output;
      return generated(output.data.master_content);
    } catch (error) {
      this.runs.delete(input.context.batchKey);
      throw error;
    }
  }

  public async generateVariant(input: {
    readonly context: ContentWriterRunContext;
    readonly masterContent: GeneratedContent;
    readonly platformCode: ContentWriterContent['platform_code'];
    readonly requestId: string;
    readonly signal?: AbortSignal;
    readonly writerInput: JsonObject;
  }): Promise<GeneratedContent> {
    const cached = this.runs.get(input.context.batchKey) ?? this.start(input);
    try {
      const output = await cached.output;
      const variant = output.data.variants.find(
        (candidate) => candidate.platform_code === input.platformCode,
      );
      if (!variant) {
        throw new GenerationWorkerError(
          'GENERATED_CONTENT_INVALID',
          `Content Writer omitted ${input.platformCode}`,
        );
      }
      cached.remaining.delete(input.platformCode);
      if (cached.remaining.size === 0) this.runs.delete(input.context.batchKey);
      return generated(variant);
    } catch (error) {
      this.runs.delete(input.context.batchKey);
      throw error;
    }
  }

  public async rewriteOfficialSiteVariant(input: {
    readonly context: ContentWriterRunContext;
    readonly currentContent: GeneratedContent;
    readonly issues: readonly string[];
    readonly masterContent: GeneratedContent;
    readonly requestId: string;
    readonly signal?: AbortSignal;
    readonly writerInput: JsonObject;
  }): Promise<GeneratedContent> {
    const revision: ContentWriterRevision = Object.freeze({
      candidate: Object.freeze({
        master_content: input.masterContent as unknown as ContentWriterData['master_content'],
        variants: Object.freeze([
          input.currentContent as unknown as ContentWriterData['variants'][number],
        ]),
      }),
      issues: Object.freeze([...input.issues]),
    });
    const output = await this.execute(input, revision);
    const variant = output.data.variants.find(
      (candidate) => candidate.platform_code === 'official_site',
    );
    if (!variant) {
      throw new GenerationWorkerError(
        'GENERATED_CONTENT_INVALID',
        'Content Writer omitted official_site during automated rewrite',
      );
    }
    return generated(variant);
  }

  private start(input: {
    readonly context: ContentWriterRunContext;
    readonly requestId: string;
    readonly signal?: AbortSignal;
    readonly writerInput: JsonObject;
  }): CachedRun {
    if (!this.adapters.has(input.context.modelKey)) {
      throw new GenerationWorkerError(
        'MODEL_ROUTE_NOT_FOUND',
        `AI Worker has no adapter for model ${input.context.modelKey}`,
      );
    }
    const platforms = requestedPlatforms(input.writerInput);
    const cached: CachedRun = {
      output: this.execute(input),
      remaining: new Set(platforms),
    };
    this.runs.set(input.context.batchKey, cached);
    return cached;
  }

  private async execute(
    input: {
      readonly context: ContentWriterRunContext;
      readonly requestId: string;
      readonly signal?: AbortSignal;
      readonly writerInput: JsonObject;
    },
    revision?: ContentWriterRevision,
  ): Promise<ContentWriterOutput> {
    const adapter = this.adapters.get(input.context.modelKey)!;
    const prompt = this.promptLoader
      ? await this.promptLoader(input.context)
      : await this.getPrompt(input.context);
    const schemas = new SchemaGuard();
    const tools = new ToolRegistry(
      [
        tool(GET_STRATEGY_VERSION_TOOL, (arguments_) =>
          this.getStrategy(input.context, input.writerInput, arguments_),
        ),
        tool(GET_PLATFORM_RULES_TOOL, (arguments_) =>
          this.getPlatformRules(input.writerInput, arguments_),
        ),
      ],
      schemas,
    );
    const skill = new ContentWriterSkill(new SkillRunner(adapter, schemas, tools));
    const invocation = {
      context: createSkillContext({
        inputHash: input.context.inputHash,
        modelKey: input.context.modelKey,
        projectId: input.context.projectId,
        promptVersionId: input.context.promptVersionId,
        requestId: input.requestId,
        runId: input.context.runId,
        skillName: 'content-writer',
        skillVersion: input.context.skillVersion,
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
      }),
      input: input.writerInput,
      maxOutputTokens: Math.min(32_768, adapter.capabilities().maxOutputTokens),
      prompt,
      recordUsage: (usage: ModelUsage) => this.recordUsage(input.context, usage),
      ...(revision ? { revision } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      temperature: input.context.modelPolicy === 'quality' ? 0.25 : 0.35,
    } as const;
    let result = await runWithStructuredOutputRetry(skill, invocation);
    if (result.output.status === 'failed') {
      throw new GenerationWorkerError(
        'CONTENT_WRITER_FAILED',
        result.output.blockers.map((blocker) => blocker.message).join('; ') ||
          'Content Writer returned failed status',
      );
    }
    const firstAssessment = assessContentWriterData(result.output.data, input.context.modelPolicy);
    if (firstAssessment.passed || input.context.modelPolicy === 'fast') return result.output;

    result = await runWithStructuredOutputRetry(skill, {
      ...invocation,
      revision: { candidate: result.output.data, issues: firstAssessment.issues },
    });
    const finalAssessment = assessContentWriterData(result.output.data, input.context.modelPolicy);
    if (!finalAssessment.passed) {
      throw new GenerationWorkerError(
        'CONTENT_QUALITY_INSUFFICIENT',
        finalAssessment.issues.join('; '),
      );
    }
    return result.output;
  }

  private async getPrompt(context: ContentWriterRunContext): Promise<ContentWriterPublishedPrompt> {
    const rows = await this.client<
      { skillName: string; systemPrompt: string; taskTemplate: string }[]
    >`
      SELECT
        skill_name AS "skillName",
        system_prompt AS "systemPrompt",
        task_template AS "taskTemplate"
      FROM prompt_versions
      WHERE id = ${context.promptVersionId}::uuid AND status = 'published'
      LIMIT 1
    `;
    const prompt = rows[0];
    if (!prompt || prompt.skillName !== 'content-writer') {
      throw new GenerationWorkerError(
        'PROMPT_VERSION_NOT_FOUND',
        'Published Content Writer prompt version was not found',
      );
    }
    return Object.freeze({
      systemPrompt: prompt.systemPrompt,
      taskTemplate: prompt.taskTemplate,
    });
  }

  private async getStrategy(
    context: ContentWriterRunContext,
    writerInput: JsonObject,
    arguments_: Readonly<Record<string, unknown>>,
  ) {
    const brandProfileId = requiredString(arguments_['brand_profile_id']);
    const rows = await this.client<{ profile: JsonObject; version: number }[]>`
      SELECT profile_json AS profile, version
      FROM brand_profiles
      WHERE
        id = ${brandProfileId}::uuid
        AND tenant_id = ${context.tenantId}::uuid
        AND workspace_id = ${context.workspaceId}::uuid
        AND status = 'published'
      LIMIT 1
    `;
    const row = rows[0];
    if (row) return { profile: row.profile, version: row.version };
    const strategy = jsonObject(writerInput['strategy']);
    const version = strategy?.['version'];
    if (
      strategy &&
      strategy['brand_profile_id'] === brandProfileId &&
      typeof version === 'number' &&
      Number.isSafeInteger(version) &&
      version > 0
    ) {
      return {
        profile: jsonObject(strategy['profile']) ?? {},
        version,
      };
    }
    throw new Error('Published brand strategy was not found');
  }

  private async getPlatformRules(
    writerInput: JsonObject,
    arguments_: Readonly<Record<string, unknown>>,
  ) {
    const versionId = requiredString(arguments_['version_id']);
    const platformCode = requiredString(arguments_['platform_code']);
    const rows = await this.client<{ rules: JsonObject; version: string }[]>`
      SELECT rules_json AS rules, version
      FROM platform_rule_versions
      WHERE
        id = ${versionId}::uuid
        AND platform_code = ${platformCode}
        AND status = 'published'
      LIMIT 1
    `;
    const row = rows[0];
    if (row) return { rules: row.rules, version: row.version };
    const rulesByCode = jsonObject(writerInput['platform_rules_by_code']);
    const supplied = rulesByCode ? jsonObject(rulesByCode[platformCode]) : undefined;
    if (supplied && supplied['version_id'] === versionId) {
      return { rules: jsonObject(supplied['rules']) ?? {}, version_id: versionId };
    }
    throw new Error('Published platform rules were not found');
  }
}

async function runWithStructuredOutputRetry(
  skill: ContentWriterSkill,
  invocation: Parameters<ContentWriterSkill['run']>[0],
) {
  try {
    return await skill.run(invocation);
  } catch (error) {
    if (!(error instanceof SkillRuntimeError) || error.code !== 'SKILL_OUTPUT_INVALID') throw error;
    return skill.run({
      ...invocation,
      temperature: Math.min(invocation.temperature ?? 0.25, 0.15),
    });
  }
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

function requestedPlatforms(input: JsonObject): readonly string[] {
  const brief = input['brief'];
  if (!isJsonObject(brief)) return [];
  const platforms = brief['platform_codes'];
  return Array.isArray(platforms)
    ? platforms.filter((value): value is string => typeof value === 'string')
    : [];
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Tool argument is invalid');
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function generated(content: ContentWriterContent): GeneratedContent {
  return Object.freeze({
    ...content,
    blocks: Object.freeze(content.blocks.map((block) => Object.freeze({ ...block }))),
    platform_code: content.platform_code,
    schema_version: 'content-writer-data@1',
  }) as GeneratedContent;
}
