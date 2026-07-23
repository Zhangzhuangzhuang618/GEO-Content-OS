import { z } from 'zod';

import {
  CursorSchema,
  IsoDateTimeSchema,
  ReasonRequestSchema,
  UuidSchema,
  VersionSchema,
  createDataResponseSchema,
} from '../common.js';

export const TenantStatusSchema = z.enum(['active', 'suspended', 'archived']);
export const TenantHealthStatusSchema = z.enum(['healthy', 'suspended', 'archived']);
export const TenantSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
export const TenantPlanCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_-]*$/u);

export const TenantListQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    plan_code: TenantPlanCodeSchema.optional(),
    search: z.string().trim().min(1).max(120).optional(),
    status: TenantStatusSchema.optional(),
  })
  .strict();

export const CreateTenantRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: TenantSlugSchema,
    plan_code: TenantPlanCodeSchema.default('trial'),
    timezone: z.string().trim().min(1).max(64).default('Asia/Shanghai'),
    owner_email: z.email().max(320),
    owner_display_name: z.string().trim().min(1).max(80),
    default_workspace_name: z.string().trim().min(1).max(120).default('默认工作区'),
  })
  .strict();

export const TenantUsageSchema = z
  .object({
    currency: z.literal('CNY'),
    ledger_entries: z.number().int().nonnegative(),
    period_end: IsoDateTimeSchema,
    period_start: IsoDateTimeSchema,
    settled_cost_cents: z.number().int().nonnegative(),
  })
  .strict();

export const TenantHealthSchema = z
  .object({
    checked_at: IsoDateTimeSchema,
    status: TenantHealthStatusSchema,
  })
  .strict();

export const PlatformTenantViewSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    health: TenantHealthSchema,
    id: UuidSchema,
    name: z.string().min(1).max(120),
    plan_code: TenantPlanCodeSchema,
    slug: TenantSlugSchema,
    status: TenantStatusSchema,
    timezone: z.string().min(1).max(64),
    updated_at: IsoDateTimeSchema,
    usage: TenantUsageSchema,
    version: VersionSchema,
  })
  .strict();

export const PlatformTenantPageSchema = z
  .object({ items: z.array(PlatformTenantViewSchema), next_cursor: CursorSchema.nullable() })
  .strict();

export const PlatformTenantResponseSchema = createDataResponseSchema(PlatformTenantViewSchema);
export const PlatformTenantPageResponseSchema = createDataResponseSchema(PlatformTenantPageSchema);
export const PlatformTenantIdSchema = UuidSchema;
export { ReasonRequestSchema as SuspendTenantRequestSchema };

export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;
export type PlatformTenantView = z.infer<typeof PlatformTenantViewSchema>;
export type TenantListQuery = z.infer<typeof TenantListQuerySchema>;
export type TenantStatus = z.infer<typeof TenantStatusSchema>;
