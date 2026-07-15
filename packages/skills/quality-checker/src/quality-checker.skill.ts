import type { ModelMessage, ModelUsage } from '@geo-content-os/adapter-model';
import {
  QUALITY_CHECKER_INPUT_SCHEMA,
  QUALITY_CHECKER_OUTPUT_SCHEMA,
  QUALITY_CHECKER_SKILL_VERSION,
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
  readonly recordUsage: (usage: ModelUsage) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

interface CheckerInput {
  readonly content_version: { readonly content: { readonly title?: string } };
  readonly fact_results: readonly {
    readonly citation_ids: readonly string[];
    readonly claim_key: string;
    readonly risk_level: string;
    readonly verdict: string;
  }[];
  readonly geo_result: { readonly scores: Readonly<Record<string, number>> };
  readonly platform_rules: { readonly rules: { readonly title_max_length?: number } };
  readonly safety_policy: { readonly max_warnings_for_pass: number };
}

export class QualityCheckerSkill {
  public constructor(private readonly runner: SkillRunner) {}

  public async run(
    invocation: QualityCheckerSkillRunInput,
  ): Promise<SkillRunResult<QualityCheckerOutput>> {
    assertContext(invocation.context);
    const result = await this.runner.run<Readonly<Record<string, unknown>>, QualityCheckerOutput>({
      context: invocation.context,
      input: invocation.input,
      inputSchema: QUALITY_CHECKER_INPUT_SCHEMA,
      maxOutputTokens: 8_192,
      messages: messages(invocation.input),
      outputSchema: QUALITY_CHECKER_OUTPUT_SCHEMA,
      recordUsage: invocation.recordUsage,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
      temperature: 0,
      toolNames: QUALITY_CHECKER_TOOL_NAMES_V1,
    });
    assertOutput(invocation.context, invocation.input as unknown as CheckerInput, result.output);
    return result;
  }
}

function messages(input: Readonly<Record<string, unknown>>): readonly ModelMessage[] {
  const examples = QUALITY_CHECKER_FEW_SHOTS_V1.flatMap<ModelMessage>((example) => [
    {
      content: JSON.stringify({ example_input: example.input, purpose: example.purpose }),
      role: 'user',
    },
    { content: JSON.stringify(example.output), role: 'assistant' },
  ]);
  return Object.freeze([
    { content: QUALITY_CHECKER_SYSTEM_PROMPT_V1, role: 'system' },
    { content: QUALITY_CHECKER_TASK_PROMPT_V1, role: 'user' },
    ...examples,
    {
      content: JSON.stringify({
        instruction:
          'Check only this input. Do not copy identifiers, trace fields, usage, issues, or decisions from examples.',
        quality_checker_input: input,
      }),
      role: 'user',
    },
  ]);
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
  const maxTitle = input.platform_rules.rules.title_max_length;
  const title = input.content_version.content.title;
  if (
    typeof maxTitle === 'number' &&
    typeof title === 'string' &&
    title.length > maxTitle &&
    !blocks.some((issue) => issue.category === 'format' && issue.location === 'title')
  )
    invalid('Quality Checker did not block a hard title limit violation');

  const citationIds = new Set(input.fact_results.flatMap((fact) => fact.citation_ids));
  if (output.data.issues.some((issue) => issue.citation_ids.some((id) => !citationIds.has(id)))) {
    invalid('Quality Checker issue references an unknown citation ID');
  }
}

function invalid(message: string): never {
  throw new SkillRuntimeError('SKILL_OUTPUT_INVALID', message);
}
