import type { JsonValue, ModelMessage, ModelUsage } from '@geo-content-os/adapter-model';
import {
  TOPIC_PLANNER_INPUT_SCHEMA,
  TOPIC_PLANNER_OUTPUT_SCHEMA,
  TOPIC_PLANNER_SKILL_VERSION,
  type TopicPlannerOutput,
} from '@geo-content-os/contracts/skills';
import {
  SkillRuntimeError,
  type SkillContext,
  type SkillRunResult,
  type SkillRunner,
  type SkillToolResult,
} from '@geo-content-os/skills/runtime';

import {
  TOPIC_PLANNER_FEW_SHOTS_V1,
  TOPIC_PLANNER_SYSTEM_PROMPT_V1,
  TOPIC_PLANNER_TASK_PROMPT_V1,
  TOPIC_PLANNER_TOOL_NAMES_V1,
} from '../contracts/v1.0.0/index.js';

export interface TopicPlannerSkillRunInput {
  readonly context: SkillContext;
  readonly input: Readonly<Record<string, unknown>>;
  readonly recordUsage: (usage: ModelUsage) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

interface PlannerInput {
  readonly keywords: readonly {
    readonly id: string;
    readonly platform_scope: readonly string[];
  }[];
  readonly platform_scope: readonly string[];
}

interface EvidenceRecord {
  readonly chunkId: string;
  readonly quoteText: string;
}

export class TopicPlannerSkill {
  public constructor(private readonly runner: SkillRunner) {}

  public async run(
    invocation: TopicPlannerSkillRunInput,
  ): Promise<SkillRunResult<TopicPlannerOutput>> {
    assertContext(invocation.context);
    const result = await this.runner.run<Readonly<Record<string, unknown>>, TopicPlannerOutput>({
      context: invocation.context,
      input: invocation.input,
      inputSchema: TOPIC_PLANNER_INPUT_SCHEMA,
      maxOutputTokens: 8_192,
      messages: messages(invocation.input),
      outputSchema: TOPIC_PLANNER_OUTPUT_SCHEMA,
      recordUsage: invocation.recordUsage,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
      temperature: 0.3,
      toolNames: TOPIC_PLANNER_TOOL_NAMES_V1,
    });
    assertOutput(
      invocation.context,
      invocation.input as unknown as PlannerInput,
      result.output,
      evidenceCatalog(result.toolResults),
    );
    return result;
  }
}

function messages(input: Readonly<Record<string, unknown>>): readonly ModelMessage[] {
  const examples = TOPIC_PLANNER_FEW_SHOTS_V1.flatMap<ModelMessage>((example) => [
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
    { content: TOPIC_PLANNER_SYSTEM_PROMPT_V1, role: 'system' },
    { content: TOPIC_PLANNER_TASK_PROMPT_V1, role: 'user' },
    ...examples,
    {
      content: JSON.stringify({
        instruction:
          'Plan candidates from this input. Do not copy identifiers, trace fields, usage, metrics, topics, or evidence from examples.',
        topic_planner_input: input,
      }),
      role: 'user',
    },
  ]);
}

function assertContext(context: SkillContext): void {
  if (context.skillName !== 'topic-planner' || context.skillVersion !== TOPIC_PLANNER_SKILL_VERSION)
    invalid('Topic Planner context has the wrong Skill identity');
}

function assertOutput(
  context: SkillContext,
  input: PlannerInput,
  output: TopicPlannerOutput,
  evidence: readonly EvidenceRecord[],
): void {
  if (
    output.skill_name !== context.skillName ||
    output.skill_version !== context.skillVersion ||
    output.trace.input_hash !== context.inputHash ||
    output.trace.prompt_version_id !== context.promptVersionId ||
    output.trace.request_id !== context.requestId ||
    output.trace.run_id !== context.runId
  )
    invalid('Topic Planner output trace does not match server-owned context');

  for (const citation of output.citations) {
    if (
      !evidence.some(
        (source) =>
          source.chunkId === citation.chunk_id && source.quoteText.includes(citation.quote_text),
      )
    )
      invalid('Topic Planner returned a citation outside search results');
  }

  const keywords = new Map(input.keywords.map((keyword) => [keyword.id, keyword]));
  let evidenceFree = false;
  for (const topic of output.data.topics) {
    const suggestion = topic.brief_suggestion;
    const selected = suggestion.keyword_ids.map((id) => keywords.get(id));
    if (
      !suggestion.keyword_ids.includes(suggestion.primary_keyword_id) ||
      selected.some((keyword) => !keyword) ||
      topic.platform_codes.some((platform) => !input.platform_scope.includes(platform)) ||
      topic.platform_codes.some(
        (platform) => !selected.some((keyword) => keyword?.platform_scope.includes(platform)),
      )
    )
      invalid('Topic Planner exceeded supplied keyword or platform scope');

    if (topic.evidence_ids.length === 0) {
      evidenceFree = true;
      if (topic.risk_level !== 'high' && topic.risk_level !== 'critical') {
        invalid('Evidence-free topic must be high or critical risk');
      }
    } else {
      for (const evidenceId of topic.evidence_ids) {
        if (!evidence.some((item) => item.chunkId === evidenceId)) {
          invalid('Topic Planner returned an evidence ID outside search results');
        }
        if (!output.citations.some((citation) => citation.chunk_id === evidenceId)) {
          invalid('Topic Planner evidence ID has no matching citation');
        }
      }
    }
  }
  if (evidenceFree && !output.warnings.some((warning) => warning.code === 'NO_EVIDENCE')) {
    invalid('Evidence-free topic requires a NO_EVIDENCE warning');
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
