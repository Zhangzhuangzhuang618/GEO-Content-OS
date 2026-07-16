import { z } from 'zod';

export const TenantStatusSchema = z.enum(['active', 'suspended', 'archived']);
const TenantViewSchema = z
  .object({
    created_at: z.iso.datetime(),
    health: z
      .object({
        checked_at: z.iso.datetime(),
        status: z.enum(['healthy', 'suspended', 'archived']),
      })
      .strict(),
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    plan_code: z.string().min(1).max(32),
    slug: z.string().min(1).max(80),
    status: TenantStatusSchema,
    timezone: z.string().min(1).max(64),
    updated_at: z.iso.datetime(),
    usage: z
      .object({
        currency: z.literal('CNY'),
        ledger_entries: z.number().int().nonnegative(),
        period_end: z.iso.datetime(),
        period_start: z.iso.datetime(),
        settled_cost_cents: z.number().int().nonnegative(),
      })
      .strict(),
    version: z.number().int().positive(),
  })
  .strict();

const MetaSchema = z.object({ request_id: z.string().min(1) }).passthrough();
export const TenantPageResponseSchema = z
  .object({
    data: z
      .object({ items: z.array(TenantViewSchema), next_cursor: z.string().nullable() })
      .strict(),
    meta: MetaSchema,
  })
  .strict();
export const TenantResponseSchema = z.object({ data: TenantViewSchema, meta: MetaSchema }).strict();
export const SessionResponseSchema = z
  .object({
    data: z
      .object({
        active_tenant_id: z.string().uuid().nullable(),
        expires_at: z.iso.datetime(),
        user: z
          .object({
            display_name: z.string().min(1),
            email: z.email(),
            id: z.string().uuid(),
          })
          .strict(),
      })
      .strict(),
    meta: MetaSchema,
  })
  .strict();
export const SupportGrantResponseSchema = z
  .object({
    data: z
      .object({
        expires_at: z.iso.datetime(),
        id: z.string().uuid(),
        platform_user_id: z.string().uuid(),
        status: z.enum(['active', 'expired', 'revoked']),
        tenant_id: z.string().uuid(),
      })
      .passthrough(),
    meta: MetaSchema,
  })
  .strict();

export type PlatformTenant = z.infer<typeof TenantViewSchema>;
export type TenantStatus = z.infer<typeof TenantStatusSchema>;
export type SupportGrant = z.infer<typeof SupportGrantResponseSchema>['data'];

export interface TenantFilters {
  readonly plan: string;
  readonly search: string;
  readonly status: string;
}
