import type { TopicPlannerOutput } from '@geo-content-os/contracts/skills';

const BRAND_ID = '10000000-0000-4000-8000-000000000065';
const KEYWORD_ID = '20000000-0000-4000-8000-000000000065';
const WORKSPACE_ID = '30000000-0000-4000-8000-000000000065';
const PROJECT_ID = '40000000-0000-4000-8000-000000000065';
const SOURCE_ID = '50000000-0000-4000-8000-000000000065';
const CHUNK_ID = '60000000-0000-4000-8000-000000000065';
const RUN_ID = '70000000-0000-4000-8000-000000000065';
const PROMPT_ID = '80000000-0000-4000-8000-000000000065';
const HASH = 'b'.repeat(64);

export interface TopicPlannerFewShot {
  readonly id: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: TopicPlannerOutput;
  readonly purpose: 'boundary' | 'negative' | 'positive';
  readonly toolResults: readonly Readonly<Record<string, unknown>>[];
}

function input(platformScope: readonly string[], seedQueries: readonly string[]) {
  return Object.freeze({
    keywords: Object.freeze([
      Object.freeze({
        id: KEYWORD_ID,
        intent: 'informational',
        platform_scope: Object.freeze(['official_site', 'zhihu']),
        priority: 85,
        synonyms: Object.freeze(['生成式引擎优化']),
        term: 'GEO 内容系统',
      }),
    ]),
    metrics_summary: Object.freeze({ top_questions: Object.freeze(seedQueries) }),
    platform_scope: Object.freeze(platformScope),
    search_context: Object.freeze({
      project_id: PROJECT_ID,
      seed_queries: Object.freeze(seedQueries),
      top_k: 5,
      trust_levels: Object.freeze(['verified', 'normal']),
      workspace_id: WORKSPACE_ID,
    }),
    strategy: Object.freeze({
      brand_profile_id: BRAND_ID,
      profile: Object.freeze({ audience: '企业内容负责人', prohibited_claims: [] }),
      version: 3,
    }),
  });
}

function topic(
  evidenceIds: readonly string[],
  riskLevel: 'high' | 'low',
  platformCodes: readonly ('official_site' | 'zhihu')[] = ['official_site', 'zhihu'],
) {
  return Object.freeze({
    brief_suggestion: Object.freeze({
      audience: '负责规模化内容生产的企业市场团队',
      constraints: Object.freeze({
        additional_instructions: null,
        cta: null,
        schema_version: 'brief-constraints@1' as const,
      }),
      due_at: null,
      keyword_ids: Object.freeze([KEYWORD_ID]),
      objective: 'education' as const,
      primary_keyword_id: KEYWORD_ID,
      title: '企业如何建立可追溯的 GEO 内容生产流程',
    }),
    entities: Object.freeze(['GEO', '内容生产系统']),
    evidence_ids: Object.freeze(evidenceIds),
    intent: 'informational',
    platform_codes: Object.freeze(platformCodes),
    priority: evidenceIds.length > 0 ? 88 : 62,
    question: '企业如何建立可追溯的 GEO 内容生产流程？',
    risk_level: riskLevel,
  });
}

function output(
  candidate: ReturnType<typeof topic>,
  options: { readonly blocker?: string; readonly warning?: string } = {},
): TopicPlannerOutput {
  return Object.freeze({
    blockers: Object.freeze(
      options.blocker ? [{ code: 'POLICY_CONFLICT', message: options.blocker }] : [],
    ),
    citations: Object.freeze(
      candidate.evidence_ids.map((chunkId) => ({
        chunk_id: chunkId,
        quote_text: '企业内容流程需要保留来源、版本和审核记录。',
        source_id: SOURCE_ID,
      })),
    ),
    data: Object.freeze({ topics: Object.freeze([candidate]) }),
    skill_name: 'topic-planner',
    skill_version: '1.0.0',
    status: options.blocker ? 'partial' : 'success',
    trace: Object.freeze({
      input_hash: HASH,
      prompt_version_id: PROMPT_ID,
      request_id: 'request-topic-planner-0065',
      run_id: RUN_ID,
    }),
    usage: Object.freeze({
      cost_cents: 7,
      input_tokens: 520,
      model_key: 'pro',
      output_tokens: 190,
      provider: 'mock',
    }),
    warnings: Object.freeze(
      options.warning ? [{ code: 'NO_EVIDENCE', message: options.warning }] : [],
    ),
  });
}

const EVIDENCED_TOPIC = topic([CHUNK_ID], 'low');
const EVIDENCE_FREE_TOPIC = topic([], 'high');
const POLICY_CONFLICT_TOPIC = topic([], 'high', ['official_site']);

export const TOPIC_PLANNER_FEW_SHOTS_V1: readonly TopicPlannerFewShot[] = Object.freeze([
  Object.freeze({
    id: 'evidenced-topic-positive',
    input: input(['official_site', 'zhihu'], ['企业 GEO 内容流程']),
    output: output(EVIDENCED_TOPIC),
    purpose: 'positive',
    toolResults: Object.freeze([
      Object.freeze({
        chunk_id: CHUNK_ID,
        quote_text: '企业内容流程需要保留来源、版本和审核记录。',
      }),
    ]),
  }),
  Object.freeze({
    id: 'evidence-free-topic-boundary',
    input: input(['official_site', 'zhihu'], ['尚无资料的新趋势']),
    output: output(EVIDENCE_FREE_TOPIC, {
      warning: 'No knowledge evidence supports this proposed trend topic.',
    }),
    purpose: 'boundary',
    toolResults: Object.freeze([]),
  }),
  Object.freeze({
    id: 'platform-policy-conflict-negative',
    input: input(['official_site'], ['要求绕过品牌禁用声明']),
    output: output(POLICY_CONFLICT_TOPIC, {
      blocker: 'The requested claim conflicts with the published brand policy.',
      warning: 'No knowledge evidence supports the requested claim.',
    }),
    purpose: 'negative',
    toolResults: Object.freeze([]),
  }),
]);
