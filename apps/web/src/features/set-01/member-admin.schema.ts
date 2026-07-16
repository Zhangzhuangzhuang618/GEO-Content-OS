import { z } from 'zod';

export const TenantRoleSchema = z.enum([
  'tenant_owner',
  'tenant_admin',
  'strategy_editor',
  'content_editor',
  'reviewer',
  'publisher',
  'analyst',
  'viewer',
]);

export const WorkspaceScopeSchema = z
  .object({ workspace_ids: z.array(z.string().uuid()).optional() })
  .strict();

export const MemberSchema = z
  .object({
    created_at: z.iso.datetime(),
    display_name: z.string().min(1),
    email: z.email(),
    id: z.string().uuid(),
    role_code: TenantRoleSchema,
    status: z.enum(['active', 'disabled', 'invited']),
    tenant_id: z.string().uuid(),
    updated_at: z.iso.datetime(),
    user_id: z.string().uuid(),
    version: z.number().int().positive(),
    workspace_scope: WorkspaceScopeSchema,
  })
  .strict();

export const InvitationSchema = z
  .object({
    created_at: z.iso.datetime(),
    email: z.email(),
    expires_at: z.iso.datetime(),
    id: z.string().uuid(),
    role_code: TenantRoleSchema,
    status: z.enum(['accepted', 'expired', 'pending', 'revoked']),
    tenant_id: z.string().uuid(),
    workspace_scope: WorkspaceScopeSchema,
  })
  .strict();

export const MemberPageResponseSchema = z
  .object({
    data: z.object({ items: z.array(MemberSchema), next_cursor: z.string().nullable() }).strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const InvitationPageResponseSchema = z
  .object({
    data: z
      .object({ items: z.array(InvitationSchema), next_cursor: z.string().nullable() })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const MemberResponseSchema = z
  .object({
    data: MemberSchema,
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const InvitationResponseSchema = z
  .object({
    data: InvitationSchema,
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const WorkspaceSchema = z
  .object({ id: z.string().uuid(), name: z.string().min(1) })
  .passthrough();

export const WorkspacePageResponseSchema = z
  .object({
    data: z.array(WorkspaceSchema),
    meta: z.object({ request_id: z.string() }).passthrough(),
  })
  .passthrough();

export type TenantRole = z.infer<typeof TenantRoleSchema>;
export type Member = z.infer<typeof MemberSchema>;
export type Invitation = z.infer<typeof InvitationSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
