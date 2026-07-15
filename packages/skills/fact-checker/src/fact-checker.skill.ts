import type { JsonValue, ModelMessage, ModelUsage } from '@geo-content-os/adapter-model';
import {
  FACT_CHECKER_INPUT_SCHEMA,
  FACT_CHECKER_OUTPUT_SCHEMA,
  FACT_CHECKER_SKILL_VERSION,
  type FactCheckerOutput,
} from '@geo-content-os/contracts/skills';
import {
  SkillRuntimeError,
  type SkillContext,
  type SkillRunResult,
  type SkillRunner,
  type SkillToolResult,
} from '@geo-content-os/skills/runtime';

import {
  FACT_CHECKER_FEW_SHOTS_V1,
  FACT_CHECKER_SYSTEM_PROMPT_V1,
  FACT_CHECKER_TASK_PROMPT_V1,
  FACT_CHECKER_TOOL_NAMES_V1,
} from '../contracts/v1.0.0/index.js';

export interface FactCheckerSkillRunInput {
  readonly context: SkillContext;
  readonly input: Readonly<Record<string, unknown>>;
  readonly recordUsage: (usage: ModelUsage) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

interface CheckerInput {
  readonly claims: readonly {
    readonly claim_key: string;
    readonly claim_text: string;
    readonly risk_level: 'critical' | 'high' | 'low' | 'medium';
  }[];
}

interface EvidenceRecord {
  readonly chunkId: string;
  readonly quoteText: string;
}

export class FactCheckerSkill {
  public constructor(private readonly runner: SkillRunner) {}

  public async run(
    invocation: FactCheckerSkillRunInput,
  ): Promise<SkillRunResult<FactCheckerOutput>> {
    assertContext(invocation.context);
    const result = await this.runner.run<Readonly<Record<string, unknown>>, FactCheckerOutput>({
      context: invocation.context,
      input: invocation.input,
      inputSchema: FACT_CHECKER_INPUT_SCHEMA,
      maxOutputTokens: 8_192,
      messages: messages(invocation.input),
      outputSchema: FACT_CHECKER_OUTPUT_SCHEMA,
      recordUsage: invocation.recordUsage,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
      temperature: 0,
      toolNames: FACT_CHECKER_TOOL_NAMES_V1,
    });
    assertOutput(
      invocation.context,
      invocation.input as unknown as CheckerInput,
      result.output,
      evidenceCatalog(result.toolResults),
    );
    return result;
  }
}

function messages(input: Readonly<Record<string, unknown>>): readonly ModelMessage[] {
  const examples = FACT_CHECKER_FEW_SHOTS_V1.flatMap<ModelMessage>((example) => [
    {
      content: JSON.stringify({
        example_input: example.input,
        example_tool_results: example.toolResults,
        purpose: example.purpose,
      }),
      role: 'user',
    },
    { content: JSON.stringify(example.output), role: 'assistant' },
  ]);
  return Object.freeze([
    { content: FACT_CHECKER_SYSTEM_PROMPT_V1, role: 'system' },
    { content: FACT_CHECKER_TASK_PROMPT_V1, role: 'user' },
    ...examples,
    {
      content: JSON.stringify({
        fact_checker_input: input,
        instruction:
          'Check this input. Do not copy identifiers, trace fields, usage, claims, or evidence from examples.',
      }),
      role: 'user',
    },
  ]);
}

function assertContext(context: SkillContext): void {
  if (context.skillName !== 'fact-checker' || context.skillVersion !== FACT_CHECKER_SKILL_VERSION) {
    invalid('Fact Checker context has the wrong Skill identity');
  }
}

function assertOutput(
  context: SkillContext,
  input: CheckerInput,
  output: FactCheckerOutput,
  evidence: readonly EvidenceRecord[],
): void {
  if (
    output.skill_name !== context.skillName ||
    output.skill_version !== context.skillVersion ||
    output.trace.input_hash !== context.inputHash ||
    output.trace.prompt_version_id !== context.promptVersionId ||
    output.trace.request_id !== context.requestId ||
    output.trace.run_id !== context.runId
  ) {
    invalid('Fact Checker output trace does not match server-owned context');
  }
  if (
    output.data.results.length !== input.claims.length ||
    new Set(output.data.results.map((result) => result.claim_key)).size !== input.claims.length
  ) {
    invalid('Fact Checker did not return exactly one result per claim');
  }
  for (const citation of output.citations) {
    if (
      !evidence.some(
        (source) =>
          source.chunkId === citation.chunk_id && source.quoteText.includes(citation.quote_text),
      )
    ) {
      invalid('Fact Checker returned a citation outside search results');
    }
  }
  for (const claim of input.claims) {
    const result = output.data.results.find((candidate) => candidate.claim_key === claim.claim_key);
    if (
      !result ||
      result.claim_text !== claim.claim_text ||
      result.risk_level !== claim.risk_level
    ) {
      invalid('Fact Checker changed server-supplied claim identity or risk');
    }
    if (result.verdict === 'unsupported') {
      if (result.evidences.length > 0) invalid('Unsupported claim cannot contain evidence');
    } else {
      for (const item of result.evidences) {
        if (
          !evidence.some(
            (source) =>
              source.chunkId === item.chunk_id && source.quoteText.includes(item.quote_text),
          ) ||
          !output.citations.some(
            (citation) =>
              citation.chunk_id === item.chunk_id && citation.quote_text.includes(item.quote_text),
          )
        ) {
          invalid('Fact Checker evidence is not an exact substring of a search result');
        }
      }
    }
    if (
      (claim.risk_level === 'high' || claim.risk_level === 'critical') &&
      result.verdict === 'unsupported' &&
      output.data.overall_decision !== 'block'
    ) {
      invalid('High-risk unsupported claim must block');
    }
  }
}

function evidenceCatalog(toolResults: readonly SkillToolResult[]): readonly EvidenceRecord[] {
  const records: EvidenceRecord[] = [];
  for (const result of toolResults) {
    if (result.name === 'search_knowledge') collectEvidence(result.output, records);
  }
  return Object.freeze(records);
}

function collectEvidence(value: JsonValue, records: EvidenceRecord[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidence(item, records);
    return;
  }
  if (!record(value)) return;
  const chunkId = value['chunk_id'];
  const quoteText = value['quote_text'];
  if (typeof chunkId === 'string' && typeof quoteText === 'string') {
    records.push(Object.freeze({ chunkId, quoteText }));
  }
  for (const child of Object.values(value)) collectEvidence(child, records);
}

function record(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new SkillRuntimeError('SKILL_OUTPUT_INVALID', message);
}
