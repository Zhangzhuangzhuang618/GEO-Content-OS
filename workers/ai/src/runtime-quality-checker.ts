import type { ModelAdapter, ModelUsage } from '@geo-content-os/adapter-model';
import {
  CREATE_QUALITY_ISSUE_TOOL,
  GET_PLATFORM_RULES_TOOL,
  REQUEST_HUMAN_REVIEW_TOOL,
  SEARCH_KNOWLEDGE_TOOL,
  type SkillToolDefinitionContract,
  type QualityCheckerData,
} from '@geo-content-os/contracts/skills';
import {
  QualityCheckerSkill,
  type QualityCheckerPublishedPrompt,
} from '@geo-content-os/skills/quality-checker';
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
import type { UsageContext } from './usage-recorder.js';

export class RuntimeQualityChecker {
  public constructor(
    private readonly client: postgres.Sql,
    private readonly adapters: ReadonlyMap<string, ModelAdapter>,
    private readonly recordUsage: UsageRecorder,
    private readonly promptLoader?: (
      context: UsageContext & { readonly promptVersionId: string },
    ) => Promise<QualityCheckerPublishedPrompt>,
  ) {}

  public async evaluate(input: {
    readonly context: UsageContext & {
      readonly inputHash: string;
      readonly modelKey: string;
      readonly promptVersionId: string;
      readonly requestId: string;
      readonly runId: string;
      readonly skillVersion: string;
    };
    readonly qualityInput: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<QualityCheckerData> {
    const adapter = this.adapters.get(input.context.modelKey);
    if (!adapter) throw new Error(`AI Worker has no adapter for model ${input.context.modelKey}`);
    const schemas = new SchemaGuard();
    const tools = new ToolRegistry(
      [
        passthrough(GET_PLATFORM_RULES_TOOL),
        passthrough(SEARCH_KNOWLEDGE_TOOL),
        passthrough(CREATE_QUALITY_ISSUE_TOOL),
        passthrough(REQUEST_HUMAN_REVIEW_TOOL),
      ],
      schemas,
    );
    const skill = new QualityCheckerSkill(new SkillRunner(adapter, schemas, tools));
    const prompt = this.promptLoader
      ? await this.promptLoader(input.context)
      : await this.getPrompt(input.context.promptVersionId);
    const context = createSkillContext({
      inputHash: input.context.inputHash,
      modelKey: input.context.modelKey,
      projectId: input.context.projectId,
      promptVersionId: input.context.promptVersionId,
      requestId: input.context.requestId,
      runId: input.context.runId,
      skillName: 'quality-checker',
      skillVersion: input.context.skillVersion,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
    });
    const run = (runPrompt: QualityCheckerPublishedPrompt) =>
      skill.run({
        context,
        input: input.qualityInput,
        prompt: runPrompt,
        recordUsage: (usage) => this.recordUsage(input.context, usage),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    let result;
    try {
      result = await run(prompt);
    } catch (error) {
      if (!(error instanceof SkillRuntimeError) || error.code !== 'SKILL_OUTPUT_INVALID') {
        throw error;
      }
      result = await run(qualitySemanticRepairPrompt(prompt, input.qualityInput));
    }
    if (result.output.status === 'failed') {
      throw new Error(
        result.output.blockers.map((blocker) => blocker.message).join('; ') ||
          'Quality Checker returned failed status',
      );
    }
    return result.output.data;
  }

  private async getPrompt(promptVersionId: string): Promise<QualityCheckerPublishedPrompt> {
    const rows = await this.client<
      { skillName: string; systemPrompt: string; taskTemplate: string }[]
    >`
      SELECT
        skill_name AS "skillName",
        system_prompt AS "systemPrompt",
        task_template AS "taskTemplate"
      FROM prompt_versions
      WHERE id = ${promptVersionId}::uuid AND status = 'published'
      LIMIT 1
    `;
    const prompt = rows[0];
    if (!prompt || prompt.skillName !== 'quality-checker') {
      throw new GenerationWorkerError(
        'PROMPT_VERSION_NOT_FOUND',
        'Published Quality Checker prompt version was not found',
      );
    }
    return Object.freeze({
      systemPrompt: prompt.systemPrompt,
      taskTemplate: prompt.taskTemplate,
    });
  }
}

type UsageRecorder = (context: UsageContext, usage: ModelUsage) => Promise<void>;

function qualitySemanticRepairPrompt(
  prompt: QualityCheckerPublishedPrompt,
  input: Readonly<Record<string, unknown>>,
): QualityCheckerPublishedPrompt {
  const factResults = Array.isArray(input['fact_results']) ? input['fact_results'] : [];
  const mandatoryFactBlocks = factResults.flatMap((fact) => {
    if (!record(fact)) return [];
    const risk = fact['risk_level'];
    const verdict = fact['verdict'];
    const claimKey = fact['claim_key'];
    return (risk === 'high' || risk === 'critical') &&
      (verdict === 'unsupported' || verdict === 'conflicted') &&
      typeof claimKey === 'string'
      ? [`claim:${claimKey}`]
      : [];
  });
  return Object.freeze({
    systemPrompt: prompt.systemPrompt,
    taskTemplate: `${prompt.taskTemplate}

The previous response failed mandatory server semantic validation. Produce a fresh result and obey all of these invariants:
1. Copy geo_scores exactly from quality_checker_input.geo_result.scores.
2. Every high or critical fact whose verdict is unsupported or conflicted must have a BLOCK issue with category "fact" and location "claim:<claim_key>".
3. A result containing any BLOCK issue must use decision "block"; otherwise apply max_warnings_for_pass exactly.
4. Use only citation IDs present in fact_results.
Mandatory fact BLOCK locations for this input: ${JSON.stringify(mandatoryFactBlocks)}.
Return one complete quality data JSON object only.`,
  });
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function passthrough(definition: SkillToolDefinitionContract): SkillTool {
  const execute: SkillTool['execute'] = (arguments_) => arguments_;
  return Object.freeze({
    allowedSkills: ['quality-checker'] as const,
    description: definition.description,
    execute,
    inputSchema: definition.inputSchema,
    name: definition.name,
  });
}
