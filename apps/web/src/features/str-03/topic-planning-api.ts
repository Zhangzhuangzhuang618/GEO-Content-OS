import {
  BriefResponseSchema,
  GenerationRunResponseSchema,
  TopicPageSchema,
  type TopicCandidate,
  type TopicFilters,
  type TopicPlanInput,
} from './topic-planning.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function listTopicCandidates(
  filters: TopicFilters & { cursor?: string },
  signal?: AbortSignal,
): Promise<{ items: TopicCandidate[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: '20' });
  if (filters.cursor) query.set('cursor', filters.cursor);
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.riskLevel) query.set('risk_level', filters.riskLevel);
  if (filters.status) query.set('status', filters.status);
  const response = await fetch(`${API_ORIGIN}/api/v1/topic-candidates?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new TopicPlanningRequestError(response.status);
  const parsed = TopicPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new TopicPlanningRequestError(502);
  return { items: parsed.data.data, nextCursor: parsed.data.meta.next_cursor };
}

export async function generateTopicPlan(input: TopicPlanInput, csrf: string): Promise<string> {
  const response = await fetch(`${API_ORIGIN}/api/v1/topic-plans/generate`, {
    body: JSON.stringify({
      keyword_set_ids: input.keywordSetIds,
      max_topics: input.maxTopics,
      platform_codes: input.platformCodes,
      project_id: input.projectId,
      seed_queries: input.seedQueries,
      workspace_id: input.workspaceId,
    }),
    credentials: 'include',
    headers: writeHeaders(csrf, 'topic-plan-generate'),
    method: 'POST',
  });
  if (!response.ok) throw new TopicPlanningRequestError(response.status);
  const parsed = GenerationRunResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new TopicPlanningRequestError(502);
  return parsed.data.data.id;
}

export async function adoptTopicCandidate(topic: TopicCandidate, csrf: string): Promise<string> {
  const response = await fetch(`${API_ORIGIN}/api/v1/topic-candidates/${topic.id}/adopt`, {
    body: JSON.stringify({}),
    credentials: 'include',
    headers: {
      ...writeHeaders(csrf, 'topic-candidate-adopt'),
      'if-match': `"${topic.version}"`,
    },
    method: 'POST',
  });
  if (!response.ok) throw new TopicPlanningRequestError(response.status);
  const parsed = BriefResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new TopicPlanningRequestError(502);
  return parsed.data.data.title;
}

export class TopicPlanningRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Topic planning request failed');
    this.name = 'TopicPlanningRequestError';
  }
}

function writeHeaders(csrf: string, operation: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'idempotency-key': `${operation}-${crypto.randomUUID()}`,
    'x-csrf-token': csrf,
  };
}
