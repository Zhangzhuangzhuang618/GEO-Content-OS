import { z } from 'zod';

import { isTenantPermission, PERMISSION_CODES } from '../../permissions/index.js';
import { TENANT_ROLE_CODES } from '../../roles.js';
import {
  IsoDateTimeSchema,
  RequestMetaSchema,
  UuidSchema,
  VersionSchema,
  createDataResponseSchema,
} from '../common.js';

export const NewPasswordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
      }),
    { message: 'Password must not contain control characters' },
  );

const EmailSchema = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());
const ResetTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u);

export const LoginRequestSchema = z
  .object({
    email: EmailSchema,
    password: z.string().min(1).max(256),
    remember_me: z.boolean().default(false),
  })
  .strict();

export const SessionViewSchema = z
  .object({
    active_tenant_id: UuidSchema.nullable(),
    expires_at: IsoDateTimeSchema,
    user: z
      .object({
        display_name: z.string().min(1).max(80),
        email: z.email().max(254),
        id: UuidSchema,
      })
      .strict(),
  })
  .strict();

export const SessionResponseSchema = createDataResponseSchema(SessionViewSchema);

export const SwitchTenantRequestSchema = z.object({ tenant_id: UuidSchema }).strict();

export const TenantChoiceSchema = z
  .object({
    id: UuidSchema,
    is_active: z.boolean(),
    last_used_at: IsoDateTimeSchema.nullable(),
    name: z.string().min(1).max(120),
    role_code: z.enum(TENANT_ROLE_CODES),
    slug: z.string().min(1).max(80),
  })
  .strict();

export const TenantChoiceListResponseSchema = z
  .object({ data: z.array(TenantChoiceSchema), meta: RequestMetaSchema })
  .strict();

export const ForgotPasswordRequestSchema = z.object({ email: EmailSchema }).strict();
export const ResetPasswordRequestSchema = z
  .object({ new_password: NewPasswordSchema, token: ResetTokenSchema })
  .strict();
export const ChangePasswordRequestSchema = z
  .object({ current_password: z.string().min(1).max(256), new_password: NewPasswordSchema })
  .strict()
  .refine((value) => value.current_password !== value.new_password, {
    message: 'New password must differ from the current password',
    path: ['new_password'],
  });

export const AcceptInvitationRequestSchema = z
  .object({ display_name: z.string().trim().min(1).max(80), password: NewPasswordSchema })
  .strict();
export const InvitationTokenSchema = ResetTokenSchema;

const SupportResourceTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^(?:\*|[a-z][a-z0-9_.-]*)$/u);

export const SupportAccessScopeSchema = z
  .object({
    permissions: z
      .array(z.enum(PERMISSION_CODES))
      .min(1)
      .max(32)
      .transform((values) => [...new Set(values)].sort())
      .refine((values) => values.every((permission) => isTenantPermission(permission)), {
        message: 'Support access only accepts tenant-scoped permissions',
      }),
    resource_types: z
      .array(SupportResourceTypeSchema)
      .min(1)
      .max(64)
      .transform((values) => [...new Set(values)].sort()),
  })
  .strict();

export const SupportGrantRequestSchema = z
  .object({
    expires_at: IsoDateTimeSchema,
    platform_user_id: UuidSchema,
    reason: z.string().trim().min(1).max(2_000),
    scope: SupportAccessScopeSchema,
    tenant_id: UuidSchema,
  })
  .strict();

export const SupportGrantViewSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    expires_at: IsoDateTimeSchema,
    granted_by: UuidSchema,
    id: UuidSchema,
    platform_user_id: UuidSchema,
    reason: z.string().min(1).max(2_000),
    revoked_at: IsoDateTimeSchema.nullable(),
    scope: SupportAccessScopeSchema.extend({
      schema_version: z.literal('support-access@1'),
    }).strict(),
    status: z.enum(['active', 'expired', 'revoked']),
    tenant_id: UuidSchema,
  })
  .strict();
export const SupportGrantResponseSchema = createDataResponseSchema(SupportGrantViewSchema);

export const TenantViewSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    name: z.string().min(1).max(120),
    plan_code: z.string().min(1).max(32),
    slug: z.string().min(1).max(80),
    status: z.enum(['active', 'suspended', 'archived']),
    timezone: z.string().min(1).max(64),
    updated_at: IsoDateTimeSchema,
    version: VersionSchema,
  })
  .strict();
export const TenantResponseSchema = createDataResponseSchema(TenantViewSchema);
export const UpdateTenantRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one tenant field is required',
  });

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type SessionView = z.infer<typeof SessionViewSchema>;
export type SwitchTenantRequest = z.infer<typeof SwitchTenantRequestSchema>;
export type TenantChoice = z.infer<typeof TenantChoiceSchema>;
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequestSchema>;
export type SupportAccessScopeRequest = z.infer<typeof SupportAccessScopeSchema>;
export type SupportGrantRequest = z.infer<typeof SupportGrantRequestSchema>;
export type SupportGrantView = z.infer<typeof SupportGrantViewSchema>;
export type TenantView = z.infer<typeof TenantViewSchema>;
export type UpdateTenantRequest = z.infer<typeof UpdateTenantRequestSchema>;
