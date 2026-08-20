import type { ModelMessage, ModelUsage } from '@geo-content-os/adapter-model';
import {
  findPublishedOwnerCompanyNames,
  isAllowedCompanyReference,
  isDisallowedCompanyReferenceAtLocation,
} from '@geo-content-os/contracts';
import {
  QUALITY_CHECKER_DATA_SCHEMA,
  QUALITY_CHECKER_INPUT_SCHEMA,
  QUALITY_CHECKER_SKILL_VERSION,
  type QualityCheckerData,
  type QualityCheckerOutput,
} from '@geo-content-os/contracts/skills';
import {
  SkillRuntimeError,
  type SkillContext,
  type SkillRunResult,
  type SkillRunner,
} from '@geo-content-os/skills/runtime';
import { isDeepStrictEqual } from 'node:util';

import {
  QUALITY_CHECKER_FEW_SHOTS_V1,
  QUALITY_CHECKER_SYSTEM_PROMPT_V1,
  QUALITY_CHECKER_TASK_PROMPT_V1,
  QUALITY_CHECKER_TOOL_NAMES_V1,
} from '../contracts/v1.0.0/index.js';

export interface QualityCheckerSkillRunInput {
  readonly context: SkillContext;
  readonly input: Readonly<Record<string, unknown>>;
  readonly prompt?: QualityCheckerPublishedPrompt;
  readonly recordUsage: (usage: ModelUsage) => Promise<void> | void;
  readonly signal?: AbortSignal;
  readonly toolNames?: readonly string[];
}

export interface QualityCheckerPublishedPrompt {
  readonly systemPrompt: string;
  readonly taskTemplate: string;
}

interface CheckerInput {
  readonly brand_policy: { readonly policy: Readonly<Record<string, unknown>> };
  readonly content_version: { readonly content: Readonly<Record<string, unknown>> };
  readonly fact_results: readonly {
    readonly citation_ids: readonly string[];
    readonly claim_key: string;
    readonly risk_level: string;
    readonly verdict: string;
  }[];
  readonly geo_result: { readonly scores: Readonly<Record<string, number>> };
  readonly platform_rules: {
    readonly platform_code?: string;
    readonly rules: {
      readonly contact_in_content_forbidden?: boolean;
      readonly title_max_characters?: number;
      readonly title_max_length?: number;
    };
  };
  readonly safety_policy: { readonly max_warnings_for_pass: number };
}

export class QualityCheckerSkill {
  public constructor(private readonly runner: SkillRunner) {}

  public async run(
    invocation: QualityCheckerSkillRunInput,
  ): Promise<SkillRunResult<QualityCheckerOutput>> {
    assertContext(invocation.context);
    const result = await this.runner.run<Readonly<Record<string, unknown>>, QualityCheckerData>({
      context: invocation.context,
      input: invocation.input,
      inputSchema: QUALITY_CHECKER_INPUT_SCHEMA,
      maxOutputTokens: 8_192,
      messages: messages(invocation.input, invocation.prompt),
      outputSchema: QUALITY_CHECKER_DATA_SCHEMA,
      recordUsage: invocation.recordUsage,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
      temperature: 0,
      toolNames: invocation.toolNames ?? QUALITY_CHECKER_TOOL_NAMES_V1,
    });
    const output = serverOwnedOutput(invocation.context, result.output, result.usages);
    assertOutput(invocation.context, invocation.input as unknown as CheckerInput, output);
    return Object.freeze({ ...result, output });
  }
}

function messages(
  input: Readonly<Record<string, unknown>>,
  prompt?: QualityCheckerPublishedPrompt,
): readonly ModelMessage[] {
  const allowHighRiskExample = hasEligibleHighRiskFact(input);
  const examples = QUALITY_CHECKER_FEW_SHOTS_V1.flatMap<ModelMessage>((example) => {
    const data = allowHighRiskExample
      ? example.output.data
      : {
          ...example.output.data,
          issues: example.output.data.issues.filter((issue) => !isHighRiskFactRule(issue.rule_id)),
        };
    const exampleInput = allowHighRiskExample
      ? example.input
      : withoutEligibleHighRiskFacts(example.input);
    return [
      {
        content: JSON.stringify({ example_input: exampleInput, purpose: example.purpose }),
        role: 'user',
      },
      { content: JSON.stringify(data), role: 'assistant' },
    ];
  });
  return Object.freeze([
    {
      content: prompt
        ? `${QUALITY_CHECKER_SYSTEM_PROMPT_V1}\n\nPublished prompt policy:\n${prompt.systemPrompt}`
        : QUALITY_CHECKER_SYSTEM_PROMPT_V1,
      role: 'system',
    },
    {
      content: prompt
        ? `${QUALITY_CHECKER_TASK_PROMPT_V1}\n\nPublished task policy:\n${prompt.taskTemplate}`
        : QUALITY_CHECKER_TASK_PROMPT_V1,
      role: 'user',
    },
    ...examples,
    {
      content: JSON.stringify({
        instruction:
          'Check only this input and return only score, decision, issues, and geo_scores. The server adds identity, status, usage, and trace. Do not copy findings or decisions from examples.',
        quality_checker_input: input,
      }),
      role: 'user',
    },
  ]);
}

function serverOwnedOutput(
  context: SkillContext,
  data: QualityCheckerData,
  usages: readonly ModelUsage[],
): QualityCheckerOutput {
  const blocked = data.decision === 'block';
  return Object.freeze({
    blockers: Object.freeze(
      blocked
        ? [{ code: 'POLICY_BLOCK', message: 'A frozen quality rule blocked this content.' }]
        : [],
    ),
    citations: Object.freeze([]),
    data,
    skill_name: 'quality-checker' as const,
    skill_version: context.skillVersion,
    status: 'success' as const,
    trace: Object.freeze({
      input_hash: context.inputHash,
      prompt_version_id: context.promptVersionId,
      request_id: context.requestId,
      run_id: context.runId,
    }),
    usage: Object.freeze({
      cost_cents: 0,
      input_tokens: usages.reduce((total, usage) => total + usage.inputTokens, 0),
      model_key: context.modelKey,
      output_tokens: usages.reduce((total, usage) => total + usage.outputTokens, 0),
      provider: usages[0]?.providerCode ?? 'unknown',
    }),
    warnings: Object.freeze([]),
  });
}

function assertContext(context: SkillContext): void {
  if (
    context.skillName !== 'quality-checker' ||
    context.skillVersion !== QUALITY_CHECKER_SKILL_VERSION
  ) {
    invalid('Quality Checker context has the wrong Skill identity');
  }
}

function assertOutput(
  context: SkillContext,
  input: CheckerInput,
  output: QualityCheckerOutput,
): void {
  if (
    output.skill_name !== context.skillName ||
    output.skill_version !== context.skillVersion ||
    output.trace.input_hash !== context.inputHash ||
    output.trace.prompt_version_id !== context.promptVersionId ||
    output.trace.request_id !== context.requestId ||
    output.trace.run_id !== context.runId
  )
    invalid('Quality Checker output trace does not match server-owned context');

  if (!isDeepStrictEqual(output.data.geo_scores, input.geo_result.scores)) {
    invalid('Quality Checker changed the supplied GEO scores');
  }
  const blocks = output.data.issues.filter((issue) => issue.severity === 'BLOCK');
  const warnings = output.data.issues.filter((issue) => issue.severity === 'WARN');
  const expectedDecision =
    blocks.length > 0
      ? 'block'
      : warnings.length > input.safety_policy.max_warnings_for_pass
        ? 'revise'
        : 'pass';
  if (output.data.decision !== expectedDecision)
    invalid('Quality Checker decision violates the frozen gate');
  if (
    (expectedDecision === 'block') !==
    output.blockers.some((blocker) => blocker.code === 'POLICY_BLOCK')
  )
    invalid('Quality Checker POLICY_BLOCK does not match its decision');

  for (const fact of input.fact_results) {
    if (
      (fact.risk_level === 'high' || fact.risk_level === 'critical') &&
      (fact.verdict === 'unsupported' || fact.verdict === 'conflicted') &&
      !blocks.some(
        (issue) => issue.category === 'fact' && issue.location === `claim:${fact.claim_key}`,
      )
    )
      invalid('Quality Checker did not block a high-risk unsupported or conflicted fact');
  }
  const maxTitle = titleMaxCharacters(input.platform_rules.rules);
  const title = input.content_version.content.title;
  const titleLength = typeof title === 'string' ? [...title].length : null;
  if (
    typeof maxTitle === 'number' &&
    titleLength !== null &&
    titleLength > maxTitle &&
    !blocks.some((issue) => issue.category === 'format' && issue.location === 'title')
  )
    invalid('Quality Checker did not block a hard title limit violation');
  if (
    typeof maxTitle === 'number' &&
    titleLength !== null &&
    titleLength <= maxTitle &&
    blocks.some(
      (issue) =>
        issue.category === 'format' && issue.location === 'title' && isTitleMaxRule(issue.rule_id),
    )
  ) {
    invalid('Quality Checker falsely blocked a title that is within the hard limit');
  }

  const citationIds = new Set(input.fact_results.flatMap((fact) => fact.citation_ids));
  if (output.data.issues.some((issue) => issue.citation_ids.some((id) => !citationIds.has(id)))) {
    invalid('Quality Checker issue references an unknown citation ID');
  }
  assertVerifiableIssues(input, output.data.issues);
}

function titleMaxCharacters(rules: CheckerInput['platform_rules']['rules']): number | undefined {
  return rules.title_max_length ?? rules.title_max_characters;
}

function isTitleMaxRule(ruleId: string): boolean {
  return (
    ruleId === 'platform.title.max_length' ||
    ruleId.endsWith('.title.max_length') ||
    ruleId.endsWith('.title.max_characters') ||
    ruleId.endsWith('.title_max_length') ||
    ruleId.endsWith('.title_max_characters')
  );
}

function assertVerifiableIssues(input: CheckerInput, issues: QualityCheckerData['issues']): void {
  const rejections: SemanticIssueRejection[] = [];
  const allowedCompanyNames = findPublishedOwnerCompanyNames(input.brand_policy.policy);
  for (const issue of issues) {
    if (issue.rule_id === 'brand.other_company_name') {
      const reason = invalidBrandIssueReason(input, issue, allowedCompanyNames);
      if (reason) rejections.push(rejection(issue, reason));
    }
    if (
      input.platform_rules.platform_code === 'lieju' &&
      input.platform_rules.rules.contact_in_content_forbidden === true &&
      issue.rule_id.endsWith('contact_in_content_forbidden')
    ) {
      const reason = invalidLiejuContactIssueReason(input, issue);
      if (reason) rejections.push(rejection(issue, reason));
    }
    if (
      issue.rule_id === 'fact.high_risk.unsupported' ||
      issue.rule_id === 'fact.high_risk.unsupported_or_conflicted'
    ) {
      const reason = invalidHighRiskFactIssueReason(input, issue);
      if (reason) rejections.push(rejection(issue, reason));
    }
  }
  if (rejections.length > 0) {
    invalid(
      `Quality Checker issues are unverifiable: ${JSON.stringify({
        rejections,
      })}`,
    );
  }
}

interface SemanticIssueRejection {
  readonly category: QualityCheckerData['issues'][number]['category'];
  readonly location: string | null;
  readonly reason: string;
  readonly rule_id: string;
  readonly severity: QualityCheckerData['issues'][number]['severity'];
}

function rejection(
  issue: QualityCheckerData['issues'][number],
  reason: string,
): SemanticIssueRejection {
  return Object.freeze({
    category: issue.category,
    location: issue.location,
    reason,
    rule_id: issue.rule_id,
    severity: issue.severity,
  });
}

function invalidBrandIssueReason(
  input: CheckerInput,
  issue: QualityCheckerData['issues'][number],
  allowedCompanyNames: readonly string[],
): string | null {
  if (issue.category !== 'brand') return 'category_must_be_brand';
  if (issue.severity !== 'BLOCK') return 'severity_must_be_block';
  if (!issue.location) return 'location_is_required';
  const locationText = textAtLocation(input.content_version.content, issue.location);
  if (!locationText) return 'location_does_not_resolve_to_content';
  const quotedNames = quotedCompanyNames(issue.message);
  if (quotedNames.length === 0) return 'exact_name_is_not_quoted';
  if (quotedNames.every((name) => isAllowedCompanyReference(name, allowedCompanyNames))) {
    return 'only_allowed_owner_or_generic_name_is_quoted';
  }
  if (
    quotedNames.some((name) =>
      isDisallowedCompanyReferenceAtLocation(name, locationText, allowedCompanyNames),
    )
  ) {
    return null;
  }
  return quotedNames.some((name) => locationText.includes(name))
    ? 'quoted_name_is_not_identifiable_company'
    : 'quoted_prohibited_name_is_not_present_at_location';
}

function invalidLiejuContactIssueReason(
  input: CheckerInput,
  issue: QualityCheckerData['issues'][number],
): string | null {
  if (issue.category !== 'compliance') return 'category_must_be_compliance';
  if (issue.severity !== 'BLOCK') return 'severity_must_be_block';
  if (!issue.location) return 'location_is_required';
  const locationText = textAtLocation(input.content_version.content, issue.location);
  if (!locationText) return 'location_does_not_resolve_to_content';
  return containsLiejuContactDetail(locationText)
    ? null
    : 'prohibited_contact_detail_is_not_present_at_location';
}

function invalidHighRiskFactIssueReason(
  input: CheckerInput,
  issue: QualityCheckerData['issues'][number],
): string | null {
  if (issue.category !== 'fact') return 'category_must_be_fact';
  if (issue.severity !== 'BLOCK') return 'severity_must_be_block';
  if (!issue.location?.startsWith('claim:')) return 'location_must_be_eligible_claim';
  const claimKey = issue.location.slice('claim:'.length);
  const fact = input.fact_results.find((candidate) => candidate.claim_key === claimKey);
  if (!fact) return 'claim_does_not_exist';
  if (fact.risk_level !== 'high' && fact.risk_level !== 'critical') {
    return 'claim_is_not_high_risk';
  }
  return fact.verdict === 'unsupported' || fact.verdict === 'conflicted'
    ? null
    : 'claim_is_not_unsupported_or_conflicted';
}

function quotedCompanyNames(message: string): readonly string[] {
  return Object.freeze(
    [...message.matchAll(/[“"]([^”"]{2,80})[”"]/gu)].map((match) => match[1]!.trim()),
  );
}

function containsLiejuContactDetail(value: string): boolean {
  return (
    /(?:https?:\/\/|www\.)\S+/iu.test(value) ||
    /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)/u.test(value) ||
    /(?:电话|手机|微信|QQ|联系)[：:\s]*[A-Za-z0-9+_-]{4,}/iu.test(value)
  );
}

function hasEligibleHighRiskFact(input: Readonly<Record<string, unknown>>): boolean {
  const factResults = Array.isArray(input['fact_results']) ? input['fact_results'] : [];
  return factResults.some(
    (fact) =>
      record(fact) &&
      (fact['risk_level'] === 'high' || fact['risk_level'] === 'critical') &&
      (fact['verdict'] === 'unsupported' || fact['verdict'] === 'conflicted'),
  );
}

function withoutEligibleHighRiskFacts(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const factResults = Array.isArray(input['fact_results']) ? input['fact_results'] : [];
  return {
    ...input,
    fact_results: factResults.filter(
      (fact) =>
        !record(fact) ||
        (fact['risk_level'] !== 'high' && fact['risk_level'] !== 'critical') ||
        (fact['verdict'] !== 'unsupported' && fact['verdict'] !== 'conflicted'),
    ),
  };
}

function isHighRiskFactRule(ruleId: string): boolean {
  return (
    ruleId === 'fact.high_risk.unsupported' || ruleId === 'fact.high_risk.unsupported_or_conflicted'
  );
}

function textAtLocation(
  content: Readonly<Record<string, unknown>>,
  location: string | null,
): string | null {
  if (!location) return null;
  if (location === 'title' || location === 'summary') {
    const value = content[location];
    return typeof value === 'string' ? value : null;
  }
  const blocks = Array.isArray(content['blocks']) ? content['blocks'] : [];
  if (location === 'content' || location === 'blocks') {
    return [content['title'], content['summary'], content['cta'], ...blocks.map(blockText)]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
  }
  const indexed = /^blocks\[(\d+)\](?:\.text)?$/u.exec(location);
  if (indexed) return blockText(blocks[Number(indexed[1])]);
  const keyed = /^blocks\.([^.]+)(?:\.text)?$/u.exec(location);
  if (!keyed) return null;
  const block = blocks.find(
    (candidate) => record(candidate) && candidate['block_key'] === keyed[1],
  );
  return blockText(block);
}

function blockText(value: unknown): string | null {
  return record(value) && typeof value['text'] === 'string' ? value['text'] : null;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new SkillRuntimeError('SKILL_OUTPUT_INVALID', message);
}
