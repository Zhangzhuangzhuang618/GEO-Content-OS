import { TENANT_ROLE_CODES } from '@geo-content-os/contracts';
import { z } from 'zod';

import { NewPasswordSchema } from '../password/password.dto.js';

const WorkspaceScopeSchema = z
  .object({
    workspace_ids: z
      .array(z.string().uuid())
      .max(100)
      .transform((values) => [...new Set(values)].sort())
      .optional(),
  })
  .strict();

export const CreateInvitationRequestSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.trim().toLowerCase()),
    role_code: z.enum(TENANT_ROLE_CODES),
    workspace_scope: WorkspaceScopeSchema.default({}),
  })
  .strict();

export const AcceptInvitationRequestSchema = z
  .object({
    display_name: z.string().trim().min(1).max(80),
    password: NewPasswordSchema,
  })
  .strict();

export const InvitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u);
export const InvitationIdSchema = z.string().uuid();

export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequestSchema>;

export interface InvitationView {
  readonly created_at: string;
  readonly email: string;
  readonly expires_at: string;
  readonly id: string;
  readonly role_code: CreateInvitationRequest['role_code'];
  readonly status: 'accepted' | 'expired' | 'pending' | 'revoked';
  readonly tenant_id: string;
  readonly workspace_scope: CreateInvitationRequest['workspace_scope'];
}
