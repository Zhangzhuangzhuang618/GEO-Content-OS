import type { JsonValue, ModelMessage, ModelUsage } from '@geo-content-os/adapter-model';
import {
  GEO_OPTIMIZER_INPUT_SCHEMA,
  GEO_OPTIMIZER_OUTPUT_SCHEMA,
  GEO_OPTIMIZER_SKILL_VERSION,
  type GeoOptimizedContent,
  type GeoOptimizerOutput,
} from '@geo-content-os/contracts/skills';
import {
  SkillRuntimeError,
  type SkillContext,
  type SkillRunResult,
  type SkillRunner,
  type SkillToolResult,
} from '@geo-content-os/skills/runtime';
import { isDeepStrictEqual } from 'node:util';

import {
  GEO_OPTIMIZER_FEW_SHOTS_V1,
  GEO_OPTIMIZER_SYSTEM_PROMPT_V1,
  GEO_OPTIMIZER_TASK_PROMPT_V1,
  GEO_OPTIMIZER_TOOL_NAMES_V1,
} from '../contracts/v1.0.0/index.js';

export interface GeoOptimizerSkillRunInput {
  readonly context: SkillContext;
  readonly input: Readonly<Record<string, unknown>>;
  readonly recordUsage: (usage: ModelUsage) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

interface OptimizerInput {
  readonly citations: readonly CitationInput[];
  readonly content_version: { readonly content: GeoOptimizedContent };
  readonly locked_blocks: readonly { readonly block_key: string; readonly text: string }[];
  readonly platform_rules: { readonly platform_code: string };
}

interface CitationInput {
  readonly chunk_id: string;
  readonly citation_id: string;
  readonly claim_key: string;
  readonly claim_text: string;
  readonly quote_text: string;
  readonly source_id: string;
}

interface EvidenceRecord {
  readonly chunkId: string;
  readonly citationId?: string;
  readonly quoteText: string;
  readonly sourceId?: string;
}

export class GeoOptimizerSkill {
  public constructor(private readonly runner: SkillRunner) {}

  public async run(
    invocation: GeoOptimizerSkillRunInput,
  ): Promise<SkillRunResult<GeoOptimizerOutput>> {
    assertContext(invocation.context);
    const result = await this.runner.run<Readonly<Record<string, unknown>>, GeoOptimizerOutput>({
      context: invocation.context,
      input: invocation.input,
      inputSchema: GEO_OPTIMIZER_INPUT_SCHEMA,
      maxOutputTokens: 8_192,
      messages: messages(invocation.input),
      outputSchema: GEO_OPTIMIZER_OUTPUT_SCHEMA,
      recordUsage: invocation.recordUsage,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
      temperature: 0.2,
      toolNames: GEO_OPTIMIZER_TOOL_NAMES_V1,
    });
    assertOutput(
      invocation.context,
      invocation.input as unknown as OptimizerInput,
      result.output,
      evidenceCatalog(result.toolResults),
    );
    return result;
  }
}

function messages(input: Readonly<Record<string, unknown>>): readonly ModelMessage[] {
  const examples = GEO_OPTIMIZER_FEW_SHOTS_V1.flatMap<ModelMessage>((example) => [
    {
      content: JSON.stringify({
        example_input: example.input,
        purpose: example.purpose,
      }),
      role: 'user',
    },
    { content: JSON.stringify(example.output), role: 'assistant' },
  ]);
  return Object.freeze([
    { content: GEO_OPTIMIZER_SYSTEM_PROMPT_V1, role: 'system' },
    { content: GEO_OPTIMIZER_TASK_PROMPT_V1, role: 'user' },
    ...examples,
    {
      content: JSON.stringify({
        geo_optimizer_input: input,
        instruction:
          'Optimize only this content. Do not copy identifiers, trace fields, usage, scores, or content from examples.',
      }),
      role: 'user',
    },
  ]);
}

function assertContext(context: SkillContext): void {
  if (
    context.skillName !== 'geo-optimizer' ||
    context.skillVersion !== GEO_OPTIMIZER_SKILL_VERSION
  ) {
    invalid('Geo Optimizer context has the wrong Skill identity');
  }
}

function assertOutput(
  context: SkillContext,
  input: OptimizerInput,
  output: GeoOptimizerOutput,
  toolEvidence: readonly EvidenceRecord[],
): void {
  if (
    output.skill_name !== context.skillName ||
    output.skill_version !== context.skillVersion ||
    output.trace.input_hash !== context.inputHash ||
    output.trace.prompt_version_id !== context.promptVersionId ||
    output.trace.request_id !== context.requestId ||
    output.trace.run_id !== context.runId
  ) {
    invalid('Geo Optimizer output trace does not match server-owned context');
  }

  assertScores(output);
  assertCitations(input, output, toolEvidence);
  assertLocks(input, output);
  assertRewritePlan(input, output);

  if (output.data.optimized_content.platform_code !== input.platform_rules.platform_code) {
    invalid('Geo Optimizer changed the target platform');
  }
  const unsafe = output.blockers.some(
    (blocker) => blocker.code === 'CITATION_LOSS' || blocker.code === 'LOCK_VIOLATION',
  );
  if (unsafe) {
    if (
      output.status !== 'failed' ||
      !isDeepStrictEqual(output.data.optimized_content, input.content_version.content)
    ) {
      invalid('Unsafe Geo Optimizer result must fail and return the original content');
    }
  }
}

function assertScores(output: GeoOptimizerOutput): void {
  const score = output.data.scores;
  const weighted =
    score.entity * 0.2 +
    score.question * 0.2 +
    score.answerability * 0.2 +
    score.evidence * 0.2 +
    score.platform_fit * 0.1 +
    score.readability_safety * 0.1;
  if (Math.abs(score.total - weighted) > 0.000_001) {
    invalid('Geo Optimizer total score does not match frozen weights');
  }
}

function assertCitations(
  input: OptimizerInput,
  output: GeoOptimizerOutput,
  toolEvidence: readonly EvidenceRecord[],
): void {
  const inputEvidence = input.citations.map((citation) => ({
    chunkId: citation.chunk_id,
    citationId: citation.citation_id,
    quoteText: citation.quote_text,
    sourceId: citation.source_id,
  }));
  const evidence = [...inputEvidence, ...toolEvidence];
  for (const citation of output.citations) {
    if (
      !evidence.some(
        (source) =>
          source.chunkId === citation.chunk_id &&
          (source.sourceId === undefined || source.sourceId === citation.source_id) &&
          source.quoteText.includes(citation.quote_text),
      )
    ) {
      invalid('Geo Optimizer returned a citation outside supplied or retrieved evidence');
    }
  }

  const optimizedMap = output.data.optimized_content.citation_map;
  const requiredCitationIds = new Set(
    input.content_version.content.citation_map.flatMap((mapping) => mapping.citation_ids),
  );
  for (const citationId of requiredCitationIds) {
    const source = input.citations.find((citation) => citation.citation_id === citationId);
    if (
      !source ||
      !output.citations.some(
        (citation) =>
          citation.chunk_id === source.chunk_id &&
          citation.source_id === source.source_id &&
          source.quote_text.includes(citation.quote_text),
      )
    ) {
      invalid('Geo Optimizer removed required citation evidence');
    }
  }
  for (const original of input.content_version.content.citation_map) {
    const optimized = optimizedMap.find(
      (mapping) =>
        mapping.claim_key === original.claim_key && mapping.claim_text === original.claim_text,
    );
    if (
      !optimized ||
      original.citation_ids.some((citationId) => !optimized.citation_ids.includes(citationId))
    ) {
      invalid('Geo Optimizer changed or removed an original citation mapping');
    }
  }

  const allowedIds = new Set([
    ...input.citations.map((citation) => citation.citation_id),
    ...toolEvidence.flatMap((item) => (item.citationId ? [item.citationId] : [])),
  ]);
  if (
    optimizedMap.some((mapping) =>
      mapping.citation_ids.some((citationId) => !allowedIds.has(citationId)),
    )
  ) {
    invalid('Geo Optimizer invented a citation ID');
  }
}

function assertLocks(input: OptimizerInput, output: GeoOptimizerOutput): void {
  for (const locked of input.locked_blocks) {
    const block = output.data.optimized_content.blocks.find(
      (candidate) => candidate.block_key === locked.block_key,
    );
    const plans = output.data.rewrite_plan.filter((item) => item.block_key === locked.block_key);
    if (!block || block.text !== locked.text || plans.some((item) => item.operation !== 'keep')) {
      invalid('Geo Optimizer changed a locked block');
    }
  }
}

function assertRewritePlan(input: OptimizerInput, output: GeoOptimizerOutput): void {
  const originalKeys = new Set(
    input.content_version.content.blocks.map((block) => block.block_key),
  );
  const optimizedKeys = new Set(
    output.data.optimized_content.blocks.map((block) => block.block_key),
  );
  for (const plan of output.data.rewrite_plan) {
    if (!optimizedKeys.has(plan.block_key)) {
      invalid('Geo Optimizer rewrite plan references a missing optimized block');
    }
    if (
      plan.operation === 'add'
        ? originalKeys.has(plan.block_key)
        : !originalKeys.has(plan.block_key)
    ) {
      invalid('Geo Optimizer rewrite plan has an invalid block operation');
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
  const citationId = value['citation_id'];
  const quoteText = value['quote_text'];
  const sourceId = value['source_id'];
  if (typeof chunkId === 'string' && typeof quoteText === 'string') {
    records.push(
      Object.freeze({
        chunkId,
        ...(typeof citationId === 'string' ? { citationId } : {}),
        quoteText,
        ...(typeof sourceId === 'string' ? { sourceId } : {}),
      }),
    );
  }
  for (const child of Object.values(value)) collectEvidence(child, records);
}

function record(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new SkillRuntimeError('SKILL_OUTPUT_INVALID', message);
}
