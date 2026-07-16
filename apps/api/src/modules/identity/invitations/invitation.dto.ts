import {
  CreateInvitationRequestSchema,
  InvitationIdSchema,
  type CreateInvitationRequest,
  type InvitationView,
} from '@geo-content-os/contracts';
import { z } from 'zod';

import { NewPasswordSchema } from '../password/password.dto.js';

export const AcceptInvitationRequestSchema = z
  .object({
    display_name: z.string().trim().min(1).max(80),
    password: NewPasswordSchema,
  })
  .strict();

export const InvitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u);

export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequestSchema>;
export { CreateInvitationRequestSchema, InvitationIdSchema };
export type { CreateInvitationRequest, InvitationView };
