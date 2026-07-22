import type { ModelMessage, ModelUsage } from '@geo-content-os/adapter-model';
import {
  CONTENT_PLATFORM_CODES,
  CONTENT_WRITER_DATA_SCHEMA,
  CONTENT_WRITER_INPUT_SCHEMA,
  CONTENT_WRITER_SKILL_VERSION,
  type ContentPlatformCode,
  type ContentWriterContent,
  type ContentWriterData,
  type ContentWriterOutput,
} from '@geo-content-os/contracts/skills';
import {
  SkillRuntimeError,
  type SkillContext,
  type SkillRunResult,
  type SkillRunner,
} from '@geo-content-os/skills/runtime';

import {
  CONTENT_WRITER_FEW_SHOTS_V1,
  CONTENT_WRITER_PLATFORM_PROMPTS_V1,
  CONTENT_WRITER_SYSTEM_PROMPT_V1,
  CONTENT_WRITER_TASK_PROMPT_V1,
  CONTENT_WRITER_TOOL_NAMES_V1,
} from '../contracts/v1.0.0/index.js';

export interface ContentWriterSkillRunInput {
  readonly context: SkillContext;
  readonly input: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens?: number;
  readonly prompt?: ContentWriterPublishedPrompt;
  readonly recordUsage: (usage: ModelUsage) => Promise<void> | void;
  readonly revision?: ContentWriterRevision;
  readonly signal?: AbortSignal;
  readonly temperature?: number;
}

export interface ContentWriterPublishedPrompt {
  readonly systemPrompt: string;
  readonly taskTemplate: string;
}

export interface ContentWriterRevision {
  readonly candidate: ContentWriterData;
  readonly issues: readonly string[];
}

interface WriterInput {
  readonly brief: { readonly platform_codes: readonly ContentPlatformCode[] };
  readonly citations: readonly {
    readonly chunk_id: string;
    readonly citation_id: string;
    readonly quote_text: string;
    readonly source_id: string;
  }[];
  readonly locked_blocks: readonly {
    readonly block_key: string;
    readonly citation_ids: readonly string[];
    readonly platform_code: 'master' | ContentPlatformCode;
    readonly text: string;
  }[];
  readonly platform_rules_by_code: Readonly<Record<string, unknown>>;
}

const MAX_OUTPUT_TOKENS = 8_192;

export class ContentWriterSkill {
  public constructor(private readonly runner: SkillRunner) {}

  public async run(
    invocation: ContentWriterSkillRunInput,
  ): Promise<SkillRunResult<ContentWriterOutput>> {
    assertContext(invocation.context);
    const generated = await this.runner.run<Readonly<Record<string, unknown>>, ContentWriterData>({
      context: invocation.context,
      input: invocation.input,
      inputSchema: CONTENT_WRITER_INPUT_SCHEMA,
      maxOutputTokens: invocation.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
      messages: messages(invocation.input, invocation.prompt, invocation.revision),
      outputSchema: CONTENT_WRITER_DATA_SCHEMA,
      recordUsage: invocation.recordUsage,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
      temperature: invocation.temperature ?? 0.4,
      toolNames: CONTENT_WRITER_TOOL_NAMES_V1,
    });
    const input = invocation.input as unknown as WriterInput;
    const output = serverOwnedOutput(invocation.context, input, generated.output, generated.usages);
    assertOutput(invocation.context, input, output);
    return Object.freeze({ ...generated, output });
  }
}

function messages(
  input: Readonly<Record<string, unknown>>,
  prompt?: ContentWriterPublishedPrompt,
  revision?: ContentWriterRevision,
): readonly ModelMessage[] {
  const patches = requestedPlatforms(input).map(
    (platformCode) => CONTENT_WRITER_PLATFORM_PROMPTS_V1[platformCode],
  );
  const examples = CONTENT_WRITER_FEW_SHOTS_V1.flatMap<ModelMessage>((example) => [
    {
      content: JSON.stringify({ example_input: example.input, purpose: example.purpose }),
      role: 'user',
    },
    { content: JSON.stringify(example.output.data), role: 'assistant' },
  ]);
  return Object.freeze([
    {
      content: prompt
        ? `${CONTENT_WRITER_SYSTEM_PROMPT_V1}\n\nPublished prompt policy:\n${prompt.systemPrompt}`
        : CONTENT_WRITER_SYSTEM_PROMPT_V1,
      role: 'system',
    },
    {
      content: prompt
        ? `${CONTENT_WRITER_TASK_PROMPT_V1}\n\nPublished task policy:\n${prompt.taskTemplate}`
        : CONTENT_WRITER_TASK_PROMPT_V1,
      role: 'user',
    },
    { content: JSON.stringify({ bound_platform_patches: patches }), role: 'user' },
    ...examples,
    ...(revision
      ? [
          {
            content: JSON.stringify({
              candidate_to_rewrite: revision.candidate,
              instruction:
                'Rewrite the complete candidate. Correct every listed quality issue while preserving grounded facts, requested platforms, locked blocks, and the output schema. Do not merely append filler.',
              quality_issues: revision.issues,
            }),
            role: 'user' as const,
          },
        ]
      : []),
    {
      content: JSON.stringify({
        content_writer_input: input,
        instruction:
          'Return only the content data object with master_content and variants. The server adds identity, status, citations, usage, and trace. Do not emit those envelope fields. Do not copy facts or platform selection from examples.',
      }),
      role: 'user',
    },
  ]);
}

function serverOwnedOutput(
  context: SkillContext,
  input: WriterInput,
  data: ContentWriterData,
  usages: readonly ModelUsage[],
): ContentWriterOutput {
  return Object.freeze({
    blockers: Object.freeze([]),
    citations: Object.freeze(
      input.citations.map((citation) =>
        Object.freeze({
          chunk_id: citation.chunk_id,
          quote_text: citation.quote_text,
          source_id: citation.source_id,
        }),
      ),
    ),
    data,
    skill_name: 'content-writer' as const,
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

function requestedPlatforms(input: Readonly<Record<string, unknown>>): ContentPlatformCode[] {
  const brief = record(input['brief']) ? input['brief'] : undefined;
  const values = brief && Array.isArray(brief['platform_codes']) ? brief['platform_codes'] : [];
  return values.filter((value): value is ContentPlatformCode =>
    CONTENT_PLATFORM_CODES.includes(value as ContentPlatformCode),
  );
}

function assertContext(context: SkillContext): void {
  if (
    context.skillName !== 'content-writer' ||
    context.skillVersion !== CONTENT_WRITER_SKILL_VERSION
  ) {
    invalid('Content Writer context has the wrong Skill identity');
  }
}

function assertOutput(
  context: SkillContext,
  input: WriterInput,
  output: ContentWriterOutput,
): void {
  if (
    output.skill_name !== context.skillName ||
    output.skill_version !== context.skillVersion ||
    output.trace.input_hash !== context.inputHash ||
    output.trace.prompt_version_id !== context.promptVersionId ||
    output.trace.request_id !== context.requestId ||
    output.trace.run_id !== context.runId
  ) {
    invalid('Content Writer output trace does not match server-owned context');
  }
  const requested = input.brief.platform_codes;
  const returned = output.data.variants.map((variant) => variant.platform_code);
  if (
    output.data.master_content.platform_code !== 'master' ||
    returned.length !== requested.length ||
    new Set(returned).size !== returned.length ||
    requested.some((platformCode) => !returned.includes(platformCode)) ||
    requested.some((platformCode) => !(platformCode in input.platform_rules_by_code))
  ) {
    invalid('Content Writer returned the wrong master or platform variant set');
  }
  const citationsById = new Map(
    input.citations.map((citation) => [citation.citation_id, citation]),
  );
  for (const citation of output.citations) {
    if (
      !input.citations.some(
        (source) =>
          source.chunk_id === citation.chunk_id &&
          source.source_id === citation.source_id &&
          source.quote_text.includes(citation.quote_text),
      )
    ) {
      invalid('Content Writer returned a citation outside the supplied evidence');
    }
  }
  const contents = [output.data.master_content, ...output.data.variants];
  for (const content of contents) assertCitations(content, citationsById, output);
  for (const locked of input.locked_blocks) {
    const content = contents.find((candidate) => candidate.platform_code === locked.platform_code);
    const block = content?.blocks.find((candidate) => candidate.block_key === locked.block_key);
    const mapping = content?.citation_map.find((candidate) => candidate.claim_text === locked.text);
    if (
      block?.text !== locked.text ||
      !mapping ||
      !sameStrings(mapping.citation_ids, locked.citation_ids)
    ) {
      invalid('Content Writer changed a locked block or its citations');
    }
  }
}

function assertCitations(
  content: ContentWriterContent,
  citationsById: ReadonlyMap<string, WriterInput['citations'][number]>,
  output: ContentWriterOutput,
): void {
  for (const mapping of content.citation_map) {
    if (mapping.citation_ids.length === 0) {
      invalid('Content Writer returned a factual claim without a citation');
    }
    for (const citationId of mapping.citation_ids) {
      const citation = citationsById.get(citationId);
      if (
        !citation ||
        !output.citations.some(
          (item) => item.chunk_id === citation.chunk_id && item.source_id === citation.source_id,
        )
      ) {
        invalid('Content Writer claim citations are not grounded in supplied evidence');
      }
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new SkillRuntimeError('SKILL_OUTPUT_INVALID', message);
}
