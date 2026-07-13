import type { TenantRoleCode } from '@geo-content-os/contracts';
import { z } from 'zod';

export const SwitchTenantRequestSchema = z
  .object({
    tenant_id: z.string().uuid(),
  })
  .strict();

export type SwitchTenantRequest = z.infer<typeof SwitchTenantRequestSchema>;

export interface TenantChoice {
  readonly id: string;
  readonly is_active: boolean;
  readonly last_used_at: string | null;
  readonly name: string;
  readonly role_code: TenantRoleCode;
  readonly slug: string;
}
