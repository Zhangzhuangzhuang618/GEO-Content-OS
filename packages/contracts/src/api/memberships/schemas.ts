import { z } from 'zod';

import { TENANT_ROLE_CODES } from '../../roles.js';
import {
  CursorSchema,
  IsoDateTimeSchema,
  UuidSchema,
  createDataResponseSchema,
} from '../common.js';

export const WorkspaceMembershipScopeSchema = z
  .object({
    workspace_ids: z
      .array(UuidSchema)
      .max(100)
      .refine((values) => new Set(values).size === values.length, {
        message: 'Workspace IDs must be unique',
      })
      .optional(),
  })
  .strict();

export const MembershipListQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    role_code: z.enum(TENANT_ROLE_CODES).optional(),
    search: z.string().trim().min(1).max(254).optional(),
    status: z.enum(['active', 'disabled', 'invited']).optional(),
  })
  .strict();

export const UpdateMembershipRequestSchema = z
  .object({
    role_code: z.enum(TENANT_ROLE_CODES).optional(),
    workspace_scope: WorkspaceMembershipScopeSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one membership field is required',
  });

export const MembershipIdSchema = UuidSchema;

export const MembershipViewSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    display_name: z.string().min(1).max(80),
    email: z.email().max(254),
    id: UuidSchema,
    role_code: z.enum(TENANT_ROLE_CODES),
    status: z.enum(['active', 'disabled', 'invited']),
    tenant_id: UuidSchema,
    updated_at: IsoDateTimeSchema,
    user_id: UuidSchema,
    version: z.number().int().positive(),
    workspace_scope: WorkspaceMembershipScopeSchema,
  })
  .strict();

export const MembershipPageSchema = z
  .object({
    items: z.array(MembershipViewSchema),
    next_cursor: CursorSchema.nullable(),
  })
  .strict();

export const CreateInvitationRequestSchema = z
  .object({
    email: z.email().max(254),
    role_code: z.enum(TENANT_ROLE_CODES),
    workspace_scope: WorkspaceMembershipScopeSchema.default({}),
  })
  .strict();

export const InvitationListQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().min(1).max(254).optional(),
    status: z.enum(['accepted', 'expired', 'pending', 'revoked']).optional(),
  })
  .strict();

export const InvitationIdSchema = UuidSchema;

export const InvitationViewSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    email: z.email().max(254),
    expires_at: IsoDateTimeSchema,
    id: UuidSchema,
    role_code: z.enum(TENANT_ROLE_CODES),
    status: z.enum(['accepted', 'expired', 'pending', 'revoked']),
    tenant_id: UuidSchema,
    workspace_scope: WorkspaceMembershipScopeSchema,
  })
  .strict();

export const InvitationPageSchema = z
  .object({
    items: z.array(InvitationViewSchema),
    next_cursor: CursorSchema.nullable(),
  })
  .strict();

export const MembershipResponseSchema = createDataResponseSchema(MembershipViewSchema);
export const MembershipPageResponseSchema = createDataResponseSchema(MembershipPageSchema);
export const InvitationResponseSchema = createDataResponseSchema(InvitationViewSchema);
export const InvitationPageResponseSchema = createDataResponseSchema(InvitationPageSchema);

export type WorkspaceMembershipScope = z.infer<typeof WorkspaceMembershipScopeSchema>;
export type MembershipListQuery = z.infer<typeof MembershipListQuerySchema>;
export type UpdateMembershipRequest = z.infer<typeof UpdateMembershipRequestSchema>;
export type MembershipView = z.infer<typeof MembershipViewSchema>;
export type MembershipPage = z.infer<typeof MembershipPageSchema>;
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;
export type InvitationListQuery = z.infer<typeof InvitationListQuerySchema>;
export type InvitationView = z.infer<typeof InvitationViewSchema>;
export type InvitationPage = z.infer<typeof InvitationPageSchema>;
