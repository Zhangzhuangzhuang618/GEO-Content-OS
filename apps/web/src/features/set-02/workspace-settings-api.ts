import { createRequestUuid } from '@/lib/request-uuid';

import {
  WorkspacePageSchema,
  WorkspaceResponseSchema,
  type Workspace,
  type WorkspaceForm,
} from './workspace-settings.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function listWorkspaces(signal?: AbortSignal): Promise<Workspace[]> {
  const response = await fetch(`${API_ORIGIN}/api/v1/workspaces?limit=100`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new WorkspaceRequestError(response.status);
  const parsed = WorkspacePageSchema.safeParse(await response.json());
  if (!parsed.success) throw new WorkspaceRequestError(502);
  return parsed.data.data;
}

export async function updateWorkspace(
  workspace: Workspace,
  form: WorkspaceForm,
  csrf: string,
): Promise<Workspace> {
  const response = await fetch(`${API_ORIGIN}/api/v1/workspaces/${workspace.id}`, {
    body: JSON.stringify({
      name: form.name.trim(),
      settings: {
        budget_policy: {
          hard_limit: form.hard_limit,
          monthly_limit_cny: form.monthly_limit_cny ? Number(form.monthly_limit_cny) : null,
        },
        default_platform_codes: form.default_platform_codes,
        review_policy: {
          minimum_approvals: Number(form.minimum_approvals),
          require_high_risk_signoff: form.require_high_risk_signoff,
        },
        schema_version: 'workspace-settings@1',
      },
      slug: form.slug.trim(),
      timezone: form.timezone.trim(),
    }),
    credentials: 'include',
    headers: writeHeaders(csrf, workspace.version, 'workspace-update'),
    method: 'PATCH',
  });
  return parseResponse(response);
}

export async function archiveWorkspace(
  workspace: Workspace,
  reason: string,
  csrf: string,
): Promise<Workspace> {
  const response = await fetch(`${API_ORIGIN}/api/v1/workspaces/${workspace.id}/archive`, {
    body: JSON.stringify({ reason }),
    credentials: 'include',
    headers: writeHeaders(csrf, workspace.version, 'workspace-archive'),
    method: 'POST',
  });
  return parseResponse(response);
}

export class WorkspaceRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Workspace request failed');
    this.name = 'WorkspaceRequestError';
  }
}

async function parseResponse(response: Response): Promise<Workspace> {
  if (!response.ok) throw new WorkspaceRequestError(response.status);
  const parsed = WorkspaceResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new WorkspaceRequestError(502);
  return parsed.data.data;
}

function writeHeaders(csrf: string, version: number, operation: string) {
  return {
    'content-type': 'application/json',
    'idempotency-key': `${operation}-${createRequestUuid()}`,
    'if-match': `"${version}"`,
    'x-csrf-token': csrf,
  };
}
