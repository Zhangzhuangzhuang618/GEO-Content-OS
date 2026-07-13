import type {
  PermissionCode,
  PlatformRoleCode,
  RoleCode,
  TenantRoleCode,
} from '@geo-content-os/contracts';

export interface PolicyRequirement {
  readonly mode: 'all' | 'any';
  readonly permissions: readonly PermissionCode[];
}

export interface PolicyContext {
  readonly activeTenantId: string | null;
  readonly permissions: ReadonlySet<PermissionCode>;
  readonly platformRoles: readonly PlatformRoleCode[];
  readonly roles: readonly RoleCode[];
  readonly sessionId: string;
  readonly tenantRole: TenantRoleCode | null;
  readonly userId: string;
}
