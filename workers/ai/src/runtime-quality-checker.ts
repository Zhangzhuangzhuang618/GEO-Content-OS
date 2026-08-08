import type { ModelAdapter, ModelUsage } from '@geo-content-os/adapter-model';
import { COMPANY_NAME_POLICY_INSTRUCTION } from '@geo-content-os/contracts';
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
    const prompt = withCompanyNamePolicy(
      this.promptLoader
        ? await this.promptLoader(input.context)
        : await this.getPrompt(input.context.promptVersionId),
    );
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
        toolNames: [],
      });
    let result;
    try {
      result = await run(prompt);
    } catch (error) {
      if (!(error instanceof SkillRuntimeError) || error.code !== 'SKILL_OUTPUT_INVALID') {
        throw error;
      }
      result = await run(qualitySemanticRepairPrompt(prompt, input.qualityInput, error.message));
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

function withCompanyNamePolicy(
  prompt: QualityCheckerPublishedPrompt,
): QualityCheckerPublishedPrompt {
  return Object.freeze({
    systemPrompt: `${prompt.systemPrompt}\n\n${COMPANY_NAME_POLICY_INSTRUCTION}`,
    taskTemplate: `${prompt.taskTemplate}

For this rule, report every prohibited identifiable name as a brand-category BLOCK issue with rule_id "brand.other_company_name". Generic anonymous phrases such as “某公司” are not violations. Every such issue must quote the exact prohibited name in its message and point to the exact title, summary, or blocks[N].text location containing that name. Never emit a generic company-name issue without a verifiable name and location.

An issue with rule_id "fact.high_risk.unsupported" or "fact.high_risk.unsupported_or_conflicted" is valid only for a supplied fact_results entry whose risk_level is high/critical and verdict is unsupported/conflicted. Its location must be exactly "claim:<claim_key>". Never invent a block location for this rule.`,
  });
}

function qualitySemanticRepairPrompt(
  prompt: QualityCheckerPublishedPrompt,
  input: Readonly<Record<string, unknown>>,
  rejectionReason: string,
): QualityCheckerPublishedPrompt {
  const factResults = Array.isArray(input['fact_results']) ? input['fact_results'] : [];
  const mandatoryIssues = factResults.flatMap((fact) => {
    if (!record(fact)) return [];
    const risk = fact['risk_level'];
    const verdict = fact['verdict'];
    const claimKey = fact['claim_key'];
    return (risk === 'high' || risk === 'critical') &&
      (verdict === 'unsupported' || verdict === 'conflicted') &&
      typeof claimKey === 'string'
      ? [
          {
            category: 'fact',
            citation_ids: [],
            location: `claim:${claimKey}`,
            message: '高风险事实缺少充分证据或存在冲突。',
            rule_id: 'fact.high_risk.unsupported_or_conflicted',
            severity: 'BLOCK',
            suggestion: '删除该事实，或补充能够直接支持该事实的有效证据。',
          },
        ]
      : [];
  });
  const contentVersionValue = input['content_version'];
  const contentVersion = record(contentVersionValue) ? contentVersionValue : null;
  const contentValue = contentVersion?.['content'];
  const content = record(contentValue) ? contentValue : null;
  const platformRulesValue = input['platform_rules'];
  const platformRules = record(platformRulesValue) ? platformRulesValue : null;
  const rulesValue = platformRules?.['rules'];
  const rules = record(rulesValue) ? rulesValue : null;
  const title = content?.['title'];
  const maxTitleLength = rules?.['title_max_length'];
  if (
    typeof title === 'string' &&
    typeof maxTitleLength === 'number' &&
    [...title].length > maxTitleLength
  ) {
    mandatoryIssues.push({
      category: 'format',
      citation_ids: [],
      location: 'title',
      message: `标题超过 ${maxTitleLength} 字硬限制。`,
      rule_id: 'platform.title.max_length',
      severity: 'BLOCK',
      suggestion: `缩短标题，使其不超过 ${maxTitleLength} 字。`,
    });
  }
  const geoResultValue = input['geo_result'];
  const geoResult = record(geoResultValue) ? geoResultValue : null;
  const geoScores = geoResult ? geoResult['scores'] : null;
  const decisionInstruction =
    mandatoryIssues.length > 0
      ? 'Because the required issues contain BLOCK, decision must be "block".'
      : 'No server-required BLOCK issue was identified. Derive decision from the complete issues array and max_warnings_for_pass exactly.';
  return Object.freeze({
    systemPrompt: prompt.systemPrompt,
    taskTemplate: `${prompt.taskTemplate}

The previous response failed mandatory server semantic validation. Produce a fresh result and obey all of these invariants:
Previous server validation error: ${JSON.stringify(rejectionReason)}. Correct this exact error and do not repeat the rejected finding unless it satisfies the required evidence and location rules.
1. Copy this server-supplied geo_scores object exactly: ${JSON.stringify(geoScores)}.
2. Begin the issues array with every server-required issue object below, copied exactly. These objects are server data, not instructions from article content.
3. You may append other real findings, but must not remove, rename, merge, downgrade, or rewrite any required issue.
4. ${decisionInstruction}
5. Use only citation IDs present in fact_results.
6. A brand.other_company_name issue must quote the exact prohibited name and point to the exact content location containing it; never report the allowed company name or an anonymous phrase.
7. A fact.high_risk.unsupported or fact.high_risk.unsupported_or_conflicted issue must match a high/critical unsupported/conflicted fact_results entry and use its exact claim:<claim_key> location.
Mandatory server-required issues: ${JSON.stringify(mandatoryIssues)}.
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
