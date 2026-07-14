import {
  FactPageSchema,
  FactResponseSchema,
  type Fact,
  type FactDecision,
  type FactStatus,
} from './fact.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export interface FactFilters {
  cursor?: string;
  projectId: string;
  search?: string;
  status?: FactStatus;
  workspaceId: string;
}

export async function listFacts(
  filters: FactFilters,
  signal?: AbortSignal,
): Promise<{ items: Fact[]; nextCursor: string | null }> {
  const query = new URLSearchParams({
    limit: '50',
    project_id: filters.projectId,
    workspace_id: filters.workspaceId,
  });
  if (filters.cursor) query.set('cursor', filters.cursor);
  if (filters.search) query.set('search', filters.search);
  if (filters.status) query.set('status', filters.status);
  const response = await fetch(`${API_ORIGIN}/api/v1/facts?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new FactRequestError(response.status);
  const parsed = FactPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new FactRequestError(502);
  return { items: parsed.data.data, nextCursor: parsed.data.meta.next_cursor };
}

export async function adjudicateFact(
  fact: Fact,
  decision: FactDecision,
  reason: string,
  csrf: string,
): Promise<Fact> {
  const response = await fetch(`${API_ORIGIN}/api/v1/facts/${fact.id}/verify`, {
    body: JSON.stringify({ decision, expected_updated_at: fact.updated_at, reason }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `fact-adjudication-${crypto.randomUUID()}`,
      'if-match': `"${fact.updated_at}"`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new FactRequestError(response.status);
  const parsed = FactResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new FactRequestError(502);
  return parsed.data.data;
}

export class FactRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Fact request failed');
    this.name = 'FactRequestError';
  }
}
