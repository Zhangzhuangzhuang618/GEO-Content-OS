import {
  InvitationPageResponseSchema,
  InvitationResponseSchema,
  MemberPageResponseSchema,
  MemberResponseSchema,
  WorkspacePageResponseSchema,
  type Invitation,
  type Member,
  type TenantRole,
  type Workspace,
} from './member-admin.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export interface MemberFilters {
  readonly role?: string;
  readonly search?: string;
  readonly status?: string;
}

export async function loadMemberAdmin(filters: MemberFilters, signal?: AbortSignal) {
  const memberQuery = new URLSearchParams({ limit: '100' });
  if (filters.search) memberQuery.set('search', filters.search);
  if (filters.role) memberQuery.set('role_code', filters.role);
  if (filters.status) memberQuery.set('status', filters.status);
  const [members, invitations, workspaces] = await Promise.all([
    request(`/api/v1/memberships?${memberQuery}`, MemberPageResponseSchema, signal),
    request('/api/v1/invitations?limit=100', InvitationPageResponseSchema, signal),
    request('/api/v1/workspaces?limit=100', WorkspacePageResponseSchema, signal),
  ]);
  return {
    invitations: invitations.data.items,
    members: members.data.items,
    workspaces: workspaces.data,
  };
}

export async function inviteMember(
  input: { readonly email: string; readonly role: TenantRole; readonly workspaceIds: string[] },
  csrf: string,
): Promise<Invitation> {
  const response = await fetch(`${API_ORIGIN}/api/v1/invitations`, {
    body: JSON.stringify({
      email: input.email.trim().toLowerCase(),
      role_code: input.role,
      workspace_scope: { workspace_ids: [...input.workspaceIds].sort() },
    }),
    credentials: 'include',
    headers: writeHeaders(csrf, 'member-invite'),
    method: 'POST',
  });
  return parseMutation(response, InvitationResponseSchema);
}

export async function updateMember(
  member: Member,
  input: { readonly role: TenantRole; readonly workspaceIds: string[] },
  csrf: string,
): Promise<Member> {
  const response = await fetch(`${API_ORIGIN}/api/v1/memberships/${member.id}`, {
    body: JSON.stringify({
      role_code: input.role,
      workspace_scope: { workspace_ids: [...input.workspaceIds].sort() },
    }),
    credentials: 'include',
    headers: { ...writeHeaders(csrf, 'member-update'), 'if-match': `"${member.version}"` },
    method: 'PATCH',
  });
  return parseMutation(response, MemberResponseSchema);
}

export async function changeMemberState(
  member: Member,
  action: 'disable' | 'restore',
  csrf: string,
): Promise<Member> {
  const response = await fetch(`${API_ORIGIN}/api/v1/memberships/${member.id}/${action}`, {
    ...(action === 'disable'
      ? { body: JSON.stringify({ reason: '管理员在 SET-01 禁用成员' }) }
      : {}),
    credentials: 'include',
    headers: {
      ...(action === 'disable' ? { 'content-type': 'application/json' } : {}),
      'if-match': `"${member.version}"`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  return parseMutation(response, MemberResponseSchema);
}

export class MemberAdminRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Member administration request failed');
    this.name = 'MemberAdminRequestError';
  }
}

async function request<T>(
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new MemberAdminRequestError(response.status);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new MemberAdminRequestError(502);
  return parsed.data;
}

async function parseMutation<T>(
  response: Response,
  schema: { safeParse(value: unknown): { success: true; data: { data: T } } | { success: false } },
): Promise<T> {
  if (!response.ok) throw new MemberAdminRequestError(response.status);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new MemberAdminRequestError(502);
  return parsed.data.data;
}

function writeHeaders(csrf: string, operation: string) {
  return {
    'content-type': 'application/json',
    'idempotency-key': `${operation}-${crypto.randomUUID()}`,
    'x-csrf-token': csrf,
  };
}

export type { Member, TenantRole, Workspace };
