import type { ModelMessage, ModelUsage } from '@geo-content-os/adapter-model';
import { ALLOWED_COMPANY_NAME } from '@geo-content-os/contracts';
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
  readonly content_version: { readonly content: Readonly<Record<string, unknown>> };
  readonly fact_results: readonly {
    readonly citation_ids: readonly string[];
    readonly claim_key: string;
    readonly risk_level: string;
    readonly verdict: string;
  }[];
  readonly geo_result: { readonly scores: Readonly<Record<string, number>> };
  readonly platform_rules: {
    readonly rules: {
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
  const examples = QUALITY_CHECKER_FEW_SHOTS_V1.flatMap<ModelMessage>((example) => [
    {
      content: JSON.stringify({ example_input: example.input, purpose: example.purpose }),
      role: 'user',
    },
    { content: JSON.stringify(example.output.data), role: 'assistant' },
  ]);
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
    ruleId.endsWith('.title_max_length') ||
    ruleId.endsWith('.title_max_characters')
  );
}

function assertVerifiableIssues(input: CheckerInput, issues: QualityCheckerData['issues']): void {
  for (const issue of issues) {
    if (issue.rule_id === 'brand.other_company_name') {
      const locationText = textAtLocation(input.content_version.content, issue.location);
      const quotedNames = quotedCompanyNames(issue.message);
      if (
        issue.category !== 'brand' ||
        issue.severity !== 'BLOCK' ||
        !locationText ||
        !quotedNames.some((name) => !isAllowedCompanyReference(name) && locationText.includes(name))
      ) {
        invalid('Quality Checker brand issue does not identify a prohibited name at its location');
      }
    }
    if (
      issue.rule_id === 'fact.high_risk.unsupported' ||
      issue.rule_id === 'fact.high_risk.unsupported_or_conflicted'
    ) {
      const claimKey = issue.location?.startsWith('claim:')
        ? issue.location.slice('claim:'.length)
        : '';
      const fact = input.fact_results.find((candidate) => candidate.claim_key === claimKey);
      if (
        issue.category !== 'fact' ||
        issue.severity !== 'BLOCK' ||
        !fact ||
        (fact.risk_level !== 'high' && fact.risk_level !== 'critical') ||
        (fact.verdict !== 'unsupported' && fact.verdict !== 'conflicted')
      ) {
        invalid(
          'Quality Checker high-risk fact issue does not match an unsupported or conflicted fact result',
        );
      }
    }
  }
}

function quotedCompanyNames(message: string): readonly string[] {
  return Object.freeze(
    [...message.matchAll(/[“"]([^”"]{2,80})[”"]/gu)].map((match) => match[1]!.trim()),
  );
}

function isAllowedCompanyReference(value: string): boolean {
  return (
    value === ALLOWED_COMPANY_NAME ||
    value === '某公司' ||
    value === '某搬家公司' ||
    value === '其他服务商'
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
