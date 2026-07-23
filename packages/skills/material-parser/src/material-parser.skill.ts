import type { ModelMessage, ModelUsage } from '@geo-content-os/adapter-model';
import {
  MATERIAL_PARSER_INPUT_SCHEMA,
  MATERIAL_PARSER_OUTPUT_SCHEMA,
  MATERIAL_PARSER_SKILL_VERSION,
  type MaterialParserInput,
  type MaterialParserOutput,
} from '@geo-content-os/contracts/skills';

import {
  MATERIAL_PARSER_FEW_SHOTS_V1,
  MATERIAL_PARSER_SYSTEM_PROMPT_V1,
  MATERIAL_PARSER_TASK_PROMPT_V1,
} from '../contracts/v1.0.0/index.js';
import {
  SkillRuntimeError,
  type SkillContext,
  type SkillRunResult,
  type SkillRunner,
} from '@geo-content-os/skills/runtime';

export interface MaterialParserSkillRunInput {
  readonly context: SkillContext;
  readonly input: MaterialParserInput;
  readonly recordUsage: (usage: ModelUsage) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

const MAX_OUTPUT_TOKENS = 8_192;

export class MaterialParserSkill {
  public constructor(private readonly runner: SkillRunner) {}

  public async run(
    invocation: MaterialParserSkillRunInput,
  ): Promise<SkillRunResult<MaterialParserOutput>> {
    assertContext(invocation.context);
    const result = await this.runner.run<MaterialParserInput, MaterialParserOutput>({
      context: invocation.context,
      input: invocation.input,
      inputSchema: MATERIAL_PARSER_INPUT_SCHEMA,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      messages: messages(invocation.input),
      outputSchema: MATERIAL_PARSER_OUTPUT_SCHEMA,
      recordUsage: invocation.recordUsage,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
      temperature: 0,
      toolNames: [],
    });
    assertOutput(invocation.context, invocation.input, result.output);
    return result;
  }
}

function messages(input: MaterialParserInput): readonly ModelMessage[] {
  const examples = MATERIAL_PARSER_FEW_SHOTS_V1.flatMap<ModelMessage>((example) => [
    {
      content: JSON.stringify({ example_input: example.input, purpose: example.purpose }),
      role: 'user',
    },
    { content: JSON.stringify(example.output), role: 'assistant' },
  ]);
  return Object.freeze([
    { content: MATERIAL_PARSER_SYSTEM_PROMPT_V1, role: 'system' },
    { content: MATERIAL_PARSER_TASK_PROMPT_V1, role: 'user' },
    ...examples,
    {
      content: JSON.stringify({
        instruction:
          'Parse this input. Do not copy identifiers, trace fields, usage, or facts from examples.',
        material_parser_input: input,
      }),
      role: 'user',
    },
  ]);
}

function assertContext(context: SkillContext): void {
  if (
    context.skillName !== 'material-parser' ||
    context.skillVersion !== MATERIAL_PARSER_SKILL_VERSION
  ) {
    invalid('Material Parser context has the wrong Skill identity');
  }
}

function assertOutput(
  context: SkillContext,
  input: MaterialParserInput,
  output: MaterialParserOutput,
): void {
  if (
    output.skill_name !== context.skillName ||
    output.skill_version !== context.skillVersion ||
    output.trace.input_hash !== context.inputHash ||
    output.trace.prompt_version_id !== context.promptVersionId ||
    output.trace.request_id !== context.requestId ||
    output.trace.run_id !== context.runId
  ) {
    invalid('Material Parser output trace does not match server-owned context');
  }
  if (
    output.data.document.content_hash !== input.document_metadata.content_hash ||
    output.data.document.language !== input.document_metadata.language ||
    output.data.document.title !== input.document_metadata.title
  ) {
    invalid('Material Parser output changed immutable document metadata');
  }
  if (output.citations.length > 0) {
    invalid('Material Parser cannot emit persisted citations before chunks exist');
  }
  const chunkNumbers = new Set<number>();
  for (const [index, chunk] of output.data.chunks.entries()) {
    if (
      chunk.chunk_no !== index ||
      chunkNumbers.has(chunk.chunk_no) ||
      chunk.token_count > input.parser_policy.max_tokens ||
      chunk.locator.char_start > chunk.locator.char_end ||
      chunk.locator.char_end > input.extracted_text.length
    ) {
      invalid('Material Parser returned an invalid chunk sequence or locator');
    }
    chunkNumbers.add(chunk.chunk_no);
  }
  for (const fact of output.data.candidate_facts) {
    if (!chunkNumbers.has(fact.source_chunk_no)) {
      invalid('Material Parser candidate fact does not reference a returned chunk');
    }
  }
}

function invalid(message: string): never {
  throw new SkillRuntimeError('SKILL_OUTPUT_INVALID', message);
}
