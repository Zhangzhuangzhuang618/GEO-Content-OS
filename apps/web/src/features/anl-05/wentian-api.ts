import { createRequestUuid } from '@/lib/request-uuid';

import {
  WentianBindingResponseSchema,
  WentianConnectorStatusResponseSchema,
  WentianQuerySyncResponseSchema,
  WentianSsoTicketResponseSchema,
  type WentianBinding,
  type WentianConnectorStatus,
  type WentianQuerySync,
} from './wentian.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

interface ProjectScope {
  readonly projectId: string;
  readonly workspaceId: string;
}

export async function loadWentianStatus(
  scope: ProjectScope,
  signal?: AbortSignal,
): Promise<WentianConnectorStatus> {
  const query = new URLSearchParams({
    project_id: scope.projectId,
    workspace_id: scope.workspaceId,
  });
  const response = await request(`/api/v1/integrations/wentian/status?${query}`, {
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  return parse(response, WentianConnectorStatusResponseSchema).then((result) => result.data);
}

export async function requestWentianBinding(
  scope: ProjectScope,
  csrf: string,
): Promise<WentianBinding> {
  const response = await request(
    '/api/v1/integrations/wentian/bindings',
    writeRequest('POST', scopeBody(scope), csrf, 'wentian-binding'),
  );
  return parse(response, WentianBindingResponseSchema).then((result) => result.data);
}

export async function refreshWentianBinding(
  bindingId: string,
  scope: ProjectScope,
  csrf: string,
): Promise<WentianBinding> {
  const response = await request(
    `/api/v1/integrations/wentian/bindings/${bindingId}/refresh`,
    writeRequest('POST', scopeBody(scope), csrf, 'wentian-refresh'),
  );
  return parse(response, WentianBindingResponseSchema).then((result) => result.data);
}

export async function disconnectWentianBinding(
  bindingId: string,
  csrf: string,
): Promise<WentianBinding> {
  const response = await request(`/api/v1/integrations/wentian/bindings/${bindingId}`, {
    credentials: 'include',
    headers: mutationHeaders(csrf, 'wentian-disconnect', false),
    method: 'DELETE',
  });
  return parse(response, WentianBindingResponseSchema).then((result) => result.data);
}

export async function issueWentianSsoTicket(
  scope: ProjectScope,
  csrf: string,
): Promise<{ readonly expires_at: string; readonly launch_url: string }> {
  const response = await request(
    '/api/v1/integrations/wentian/sso-tickets',
    writeRequest('POST', scopeBody(scope), csrf, 'wentian-enter'),
  );
  return parse(response, WentianSsoTicketResponseSchema).then((result) => result.data);
}

export async function syncWentianQuerySet(
  scope: ProjectScope & { readonly querySetId: string },
  csrf: string,
): Promise<WentianQuerySync> {
  const response = await request(
    '/api/v1/integrations/wentian/query-set-syncs',
    writeRequest(
      'POST',
      { ...scopeBody(scope), query_set_id: scope.querySetId },
      csrf,
      'wentian-query-sync',
    ),
  );
  return parse(response, WentianQuerySyncResponseSchema).then((result) => result.data);
}

function scopeBody(scope: ProjectScope) {
  return { project_id: scope.projectId, workspace_id: scope.workspaceId };
}

function writeRequest(
  method: 'POST',
  body: Readonly<Record<string, unknown>>,
  csrf: string,
  operation: string,
): RequestInit {
  return {
    body: JSON.stringify(body),
    credentials: 'include',
    headers: mutationHeaders(csrf, operation, true),
    method,
  };
}

function mutationHeaders(
  csrf: string,
  operation: string,
  includeContentType: boolean,
): Record<string, string> {
  return {
    ...(includeContentType ? { 'content-type': 'application/json' } : {}),
    'idempotency-key': `${operation}-${createRequestUuid()}`,
    'x-csrf-token': csrf,
  };
}

async function request(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    credentials: 'include',
    ...init,
  });
  if (!response.ok) throw await WentianRequestError.fromResponse(response);
  return response;
}

async function parse<T>(
  response: Response,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new WentianRequestError(502, null);
  return parsed.data;
}

export class WentianRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super('Wentian connector request failed');
    this.name = 'WentianRequestError';
  }

  public static async fromResponse(response: Response): Promise<WentianRequestError> {
    let code: string | null = null;
    try {
      const body = (await response.json()) as { error?: { code?: unknown } };
      code = typeof body.error?.code === 'string' ? body.error.code : null;
    } catch {
      // The UI only needs the status when the upstream response is not JSON.
    }
    return new WentianRequestError(response.status, code);
  }
}
