import {
  isTenantPermission,
  PERMISSION_CODES,
  type PermissionCode,
} from '@geo-content-os/contracts';
import { z } from 'zod';

const ResourceTypeSchema = z
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
      .array(ResourceTypeSchema)
      .min(1)
      .max(64)
      .transform((values) => [...new Set(values)].sort()),
  })
  .strict();

export const SupportGrantRequestSchema = z
  .object({
    expires_at: z.iso.datetime({ offset: true }),
    platform_user_id: z.string().uuid(),
    reason: z.string().trim().min(1).max(2_000),
    scope: SupportAccessScopeSchema,
    tenant_id: z.string().uuid(),
  })
  .strict();

export type SupportAccessScopeRequest = z.infer<typeof SupportAccessScopeSchema>;
export type SupportGrantRequest = z.infer<typeof SupportGrantRequestSchema>;

export interface SupportGrantView {
  readonly created_at: string;
  readonly expires_at: string;
  readonly granted_by: string;
  readonly id: string;
  readonly platform_user_id: string;
  readonly reason: string;
  readonly revoked_at: string | null;
  readonly scope: {
    readonly permissions: readonly PermissionCode[];
    readonly resource_types: readonly string[];
    readonly schema_version: 'support-access@1';
  };
  readonly status: 'active' | 'expired' | 'revoked';
  readonly tenant_id: string;
}
