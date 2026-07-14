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

export const TenantChoiceSchema = z
  .object({
    id: z.string().uuid(),
    is_active: z.boolean(),
    last_used_at: z.iso.datetime().nullable(),
    name: z.string().min(1),
    role_code: TenantRoleSchema,
    slug: z.string().min(1),
  })
  .strict();

export const TenantChoicesResponseSchema = z
  .object({
    data: z.array(TenantChoiceSchema),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .passthrough();

export type TenantChoice = z.infer<typeof TenantChoiceSchema>;
export type TenantRole = z.infer<typeof TenantRoleSchema>;
