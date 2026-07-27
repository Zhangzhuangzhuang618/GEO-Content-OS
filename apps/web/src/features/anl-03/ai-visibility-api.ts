import { createRequestUuid } from '@/lib/request-uuid';

import {
  QuerySetListResponseSchema,
  QuerySetResponseSchema,
  RunCreateResponseSchema,
  RunDetailResponseSchema,
  RunListResponseSchema,
  type AiVisibilityQuerySet,
  type AiVisibilityRunDetail,
  type AiVisibilityRunSummary,
} from './ai-visibility.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function createAiVisibilityQuerySet(
  input: {
    readonly brandAliases: readonly string[];
    readonly brandName: string;
    readonly competitorNames: readonly string[];
    readonly industry: string;
    readonly market: string | null;
    readonly name: string;
    readonly positioning: string | null;
    readonly projectId: string;
    readonly workspaceId: string;
  },
  csrf: string,
): Promise<AiVisibilityQuerySet> {
  const response = await fetch(`${API_ORIGIN}/api/v1/ai-visibility/query-sets`, {
    body: JSON.stringify({
      brand_aliases: input.brandAliases,
      brand_name: input.brandName,
      competitor_names: input.competitorNames,
      industry: input.industry,
      locale: 'zh-CN',
      market: input.market,
      name: input.name,
      positioning: input.positioning,
      project_id: input.projectId,
      workspace_id: input.workspaceId,
    }),
    credentials: 'include',
    headers: headers(csrf, `ai-visibility-query-set-${createRequestUuid()}`),
    method: 'POST',
  });
  return (await parse(response, QuerySetResponseSchema)).data;
}

export async function listAiVisibilityQuerySets(
  workspaceId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<readonly AiVisibilityQuerySet[]> {
  const query = new URLSearchParams({ project_id: projectId, workspace_id: workspaceId });
  const response = await fetch(`${API_ORIGIN}/api/v1/ai-visibility/query-sets?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  return (await parse(response, QuerySetListResponseSchema)).data;
}

export async function createAiVisibilityRun(
  workspaceId: string,
  querySetId: string,
  baselineRunId: string | null,
  csrf: string,
): Promise<AiVisibilityRunSummary> {
  const response = await fetch(`${API_ORIGIN}/api/v1/ai-visibility/runs`, {
    body: JSON.stringify({
      ...(baselineRunId ? { baseline_run_id: baselineRunId } : {}),
      engine_codes: ['deepseek'],
      query_set_id: querySetId,
      workspace_id: workspaceId,
    }),
    credentials: 'include',
    headers: headers(csrf, `ai-visibility-run-${createRequestUuid()}`),
    method: 'POST',
  });
  const data = (await parse(response, RunCreateResponseSchema)).data[0];
  if (!data) throw new AiVisibilityRequestError(502);
  return data;
}

export async function listAiVisibilityRuns(
  workspaceId: string,
  projectId: string,
  querySetId: string,
  signal?: AbortSignal,
): Promise<readonly AiVisibilityRunSummary[]> {
  const query = new URLSearchParams({
    limit: '20',
    project_id: projectId,
    query_set_id: querySetId,
    workspace_id: workspaceId,
  });
  const response = await fetch(`${API_ORIGIN}/api/v1/ai-visibility/runs?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  return (await parse(response, RunListResponseSchema)).data;
}

export async function getAiVisibilityRun(
  workspaceId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<AiVisibilityRunDetail> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  const response = await fetch(`${API_ORIGIN}/api/v1/ai-visibility/runs/${runId}?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  return (await parse(response, RunDetailResponseSchema)).data;
}

function headers(csrf: string, idempotencyKey: string) {
  return {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
    'x-csrf-token': csrf,
  };
}

async function parse<T>(
  response: Response,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  if (!response.ok) throw new AiVisibilityRequestError(response.status);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new AiVisibilityRequestError(502);
  return parsed.data;
}

export class AiVisibilityRequestError extends Error {
  public constructor(public readonly status: number) {
    super('AI visibility request failed');
    this.name = 'AiVisibilityRequestError';
  }
}
