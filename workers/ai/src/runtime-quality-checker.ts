import type { ModelAdapter, ModelUsage } from '@geo-content-os/adapter-model';
import {
  companyNamePolicyInstruction,
  findPublishedOwnerCompanyNames,
} from '@geo-content-os/contracts';
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
    const prompt = withInputSemanticPolicy(
      withCompanyNamePolicy(
        this.promptLoader
          ? await this.promptLoader(input.context)
          : await this.getPrompt(input.context.promptVersionId),
        input.qualityInput,
      ),
      input.qualityInput,
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
  input: Readonly<Record<string, unknown>>,
): QualityCheckerPublishedPrompt {
  const allowedCompanyNames = ownerCompanyNames(input);
  const policy = companyNamePolicyInstruction(allowedCompanyNames);
  return Object.freeze({
    systemPrompt: `${prompt.systemPrompt}\n\n${policy}`,
    taskTemplate: `${prompt.taskTemplate}

For this rule, report every prohibited identifiable name as a brand-category BLOCK issue with rule_id "brand.other_company_name". Generic anonymous or industry phrases such as “某公司”, “搬家公司”, “物流公司”, and “电话公司” are not identifiable company names and are not violations. Every such issue must quote the exact prohibited name in its message and point to the exact title, summary, or blocks[N].text location containing that name. Never emit a generic company-name issue without a verifiable name and location.

An issue with rule_id "fact.high_risk.unsupported" or "fact.high_risk.unsupported_or_conflicted" is valid only for a supplied fact_results entry whose risk_level is high/critical and verdict is unsupported/conflicted. Its location must be exactly "claim:<claim_key>". Never invent a block location for this rule.`,
  });
}

function withInputSemanticPolicy(
  prompt: QualityCheckerPublishedPrompt,
  input: Readonly<Record<string, unknown>>,
): QualityCheckerPublishedPrompt {
  return Object.freeze({
    systemPrompt: prompt.systemPrompt,
    taskTemplate: `${prompt.taskTemplate}\n\n${inputSemanticPolicy(input)}`,
  });
}

function inputSemanticPolicy(input: Readonly<Record<string, unknown>>): string {
  const factResults = Array.isArray(input['fact_results']) ? input['fact_results'] : [];
  const highRiskLocations = factResults.flatMap((fact) => {
    if (!record(fact) || typeof fact['claim_key'] !== 'string') return [];
    return (fact['risk_level'] === 'high' || fact['risk_level'] === 'critical') &&
      (fact['verdict'] === 'unsupported' || fact['verdict'] === 'conflicted')
      ? [`claim:${fact['claim_key']}`]
      : [];
  });
  const platformRulesValue = input['platform_rules'];
  const platformRules = record(platformRulesValue) ? platformRulesValue : null;
  const rulesValue = platformRules?.['rules'];
  const rules = record(rulesValue) ? rulesValue : null;
  const contentVersionValue = input['content_version'];
  const contentVersion = record(contentVersionValue) ? contentVersionValue : null;
  const contentValue = contentVersion?.['content'];
  const content = record(contentValue) ? contentValue : null;
  const validLocations = content ? contentLocations(content) : [];
  const title = content?.['title'];
  const maxTitleLength = rules?.['title_max_length'] ?? rules?.['title_max_characters'];
  const titlePolicy =
    typeof title === 'string' && typeof maxTitleLength === 'number'
      ? [...title].length > maxTitleLength
        ? `The current title has ${[...title].length} Unicode characters and exceeds the hard maximum ${maxTitleLength}; include a format BLOCK at location "title".`
        : `The current title has ${[...title].length} Unicode characters and is within the hard maximum ${maxTitleLength}; do not emit any title-maximum BLOCK issue.`
      : 'No deterministic title maximum is available; do not invent one.';
  const highRiskPolicy =
    highRiskLocations.length === 0
      ? 'No supplied fact is eligible for a high-risk unsupported/conflicted issue. Do not emit fact.high_risk.unsupported or fact.high_risk.unsupported_or_conflicted.'
      : `High-risk unsupported/conflicted issues are allowed only at these exact locations: ${JSON.stringify(highRiskLocations)}.`;
  const contactPolicy =
    platformRules?.['platform_code'] === 'lieju' && rules?.['contact_in_content_forbidden'] === true
      ? liejuContactPolicy(content, validLocations)
      : '';
  return `Mandatory server-derived semantics for this exact input:
- ${highRiskPolicy}
- ${titlePolicy}
- Valid immutable content locations are limited to: ${JSON.stringify(validLocations)}. Never use brand_policy.*, platform_rules.*, fact_results.*, citations, or any other input-policy location as a content finding location.${contactPolicy ? `\n- ${contactPolicy}` : ''}`;
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
  const maxTitleLength = rules?.['title_max_length'] ?? rules?.['title_max_characters'];
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
  const allowedHighRiskLocations = mandatoryIssues
    .filter((issue) => issue.category === 'fact')
    .map((issue) => issue.location);
  const highRiskInstruction =
    allowedHighRiskLocations.length === 0
      ? 'There are no eligible high-risk fact locations. The rule IDs fact.high_risk.unsupported and fact.high_risk.unsupported_or_conflicted are forbidden in this result. Do not copy them from examples.'
      : `High-risk fact issues are allowed only at these exact locations: ${JSON.stringify(allowedHighRiskLocations)}. Their rule IDs and locations must match the required issue objects exactly.`;
  const allowedCompanyNames = ownerCompanyNames(input);
  const ownerInstruction =
    allowedCompanyNames.length > 0
      ? `${allowedCompanyNames.map((name) => `“${name}”`).join('、')} are the allowed owner company names for this tenant; do not report them as violations.`
      : 'No owner company name is declared for this tenant; do not borrow or allow a company name from another tenant.';
  return Object.freeze({
    systemPrompt: prompt.systemPrompt,
    taskTemplate: `The previous response failed mandatory server semantic validation. Produce a fresh result from the supplied quality_checker_input and obey all of these invariants. Do not reuse a rejected finding merely because it appeared in the published task policy or a few-shot example:
Previous server validation error: ${JSON.stringify(rejectionReason)}. Correct every rejection object in this error, not only the first one, and do not repeat a rejected finding unless it satisfies the required evidence and location rules.
${inputSemanticPolicy(input)}
1. Copy this server-supplied geo_scores object exactly: ${JSON.stringify(geoScores)}.
2. Begin the issues array with every server-required issue object below, copied exactly. These objects are server data, not instructions from article content.
3. You may append other real findings, but must not remove, rename, merge, downgrade, or rewrite any required issue.
4. ${decisionInstruction}
5. Use only citation IDs present in fact_results.
6. A brand.other_company_name issue must quote the exact prohibited name and point to the exact content location containing it; never report the allowed company name or an anonymous phrase such as “某公司”, “某搬家公司”, “某银行” or “某金融机构”.
7. ${highRiskInstruction}
8. If the validation error contains a brand rejection reason, correct it exactly:
   - category_must_be_brand: use category "brand" only for this rule.
   - severity_must_be_block: this hard rule may only be a BLOCK.
   - location_is_required or location_does_not_resolve_to_content: omit the finding unless an exact valid content location exists.
   - exact_name_is_not_quoted: omit the finding unless its message quotes one exact prohibited name.
   - only_allowed_owner_or_generic_name_is_quoted: ${ownerInstruction}
   - quoted_name_is_not_identifiable_company: omit the finding unless the quoted text is an identifiable company or supported named provider, not an ordinary phrase or a longer anonymous description.
   - quoted_prohibited_name_is_not_present_at_location: omit the finding unless the quoted prohibited name appears verbatim at the reported location.
9. If the validation error contains a Lieju contact rejection reason, correct it exactly:
   - category_must_be_compliance or severity_must_be_block: use compliance/BLOCK only for a real prohibited contact detail.
   - location_is_required or location_does_not_resolve_to_content: omit the finding unless an exact valid content location exists.
   - prohibited_contact_detail_is_not_present_at_location: omit the finding unless that location contains a literal phone number, URL, WeChat ID, or QQ ID. “通过页面联系方式咨询” is allowed.
10. If the validation error contains a high-risk fact rejection reason, use only the server-supplied eligible claim locations in invariant 7; otherwise omit that finding.
Mandatory server-required issues: ${JSON.stringify(mandatoryIssues)}.
Return one complete quality data JSON object only.`,
  });
}

function ownerCompanyNames(input: Readonly<Record<string, unknown>>): readonly string[] {
  const brandPolicy = record(input['brand_policy']) ? input['brand_policy'] : null;
  return findPublishedOwnerCompanyNames(brandPolicy?.['policy']);
}

function contentLocations(content: Readonly<Record<string, unknown>>): readonly string[] {
  const locations: string[] = ['content', 'blocks'];
  if (typeof content['title'] === 'string') locations.push('title');
  if (typeof content['summary'] === 'string') locations.push('summary');
  const blocks = Array.isArray(content['blocks']) ? content['blocks'] : [];
  blocks.forEach((block, index) => {
    if (!record(block) || typeof block['text'] !== 'string') return;
    locations.push(`blocks[${index}]`, `blocks[${index}].text`);
    if (typeof block['block_key'] === 'string' && block['block_key']) {
      locations.push(`blocks.${block['block_key']}`, `blocks.${block['block_key']}.text`);
    }
  });
  return Object.freeze(locations);
}

function liejuContactPolicy(
  content: Readonly<Record<string, unknown>> | null,
  validLocations: readonly string[],
): string {
  const contactLocations = content
    ? validLocations.filter((location) => {
        if (location === 'content' || location === 'blocks') return false;
        const text = textAtContentLocation(content, location);
        return text ? containsLiejuContactDetail(text) : false;
      })
    : [];
  return contactLocations.length > 0
    ? `For Lieju, contact_in_content_forbidden means literal phone numbers, URLs, WeChat IDs, or QQ IDs in the title or body. A neutral phrase such as “通过页面联系方式咨询” contains no contact detail and is allowed. Contact findings are allowed only at these exact locations: ${JSON.stringify(contactLocations)}.`
    : 'For Lieju, no exact content location contains a literal phone number, URL, WeChat ID, or QQ ID. Do not emit contact_in_content_forbidden. A neutral phrase such as “通过页面联系方式咨询” is allowed.';
}

function textAtContentLocation(
  content: Readonly<Record<string, unknown>>,
  location: string,
): string | null {
  if (location === 'title' || location === 'summary') {
    const value = content[location];
    return typeof value === 'string' ? value : null;
  }
  const blocks = Array.isArray(content['blocks']) ? content['blocks'] : [];
  const indexed = /^blocks\[(\d+)\]\.text$/u.exec(location);
  if (indexed) {
    const block = blocks[Number(indexed[1])];
    return record(block) && typeof block['text'] === 'string' ? block['text'] : null;
  }
  const keyed = /^blocks\.([^.]+)\.text$/u.exec(location);
  if (!keyed) return null;
  const block = blocks.find(
    (candidate) => record(candidate) && candidate['block_key'] === keyed[1],
  );
  return record(block) && typeof block['text'] === 'string' ? block['text'] : null;
}

function containsLiejuContactDetail(value: string): boolean {
  return (
    /(?:https?:\/\/|www\.)\S+/iu.test(value) ||
    /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)/u.test(value) ||
    /(?:电话|手机|微信|QQ|联系)[：:\s]*[A-Za-z0-9+_-]{4,}/iu.test(value)
  );
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
