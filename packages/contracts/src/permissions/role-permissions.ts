import type { RoleCode } from '../roles.js';
import type { PermissionCode } from './codes.js';

const TENANT_MEMBER_READ_PERMISSIONS = [
  'tenant.profile.read',
  'tenant.workspaces.read',
  'strategy.read',
  'knowledge.read',
  'content.read',
  'review.read',
  'publishing.read',
] as const satisfies readonly PermissionCode[];

const TENANT_ADMIN_OPERATIONAL_PERMISSIONS = [
  ...TENANT_MEMBER_READ_PERMISSIONS,
  'tenant.profile.manage',
  'tenant.members.read',
  'tenant.members.manage',
  'tenant.workspaces.manage',
  'strategy.manage',
  'knowledge.sources.manage',
  'knowledge.facts.verify',
  'content.briefs.manage',
  'content.production.manage',
  'review.decide',
  'publishing.manage',
  'analytics.read',
  'cost.read',
] as const satisfies readonly PermissionCode[];

export const ROLE_PERMISSIONS = Object.freeze({
  platform_admin: Object.freeze([
    'platform.tenants.manage',
    'platform.support_access.manage',
    'platform.models.manage',
    'platform.audit.read',
  ]),
  platform_operator: Object.freeze([
    'platform.rules.manage',
    'platform.prompts.manage',
    'platform.runs.monitor',
  ]),
  tenant_owner: Object.freeze([
    ...TENANT_ADMIN_OPERATIONAL_PERMISSIONS,
    'tenant.billing.read',
    'tenant.billing.manage',
    'cost.rates.read',
    'audit.read',
    'audit.export',
  ]),
  tenant_admin: Object.freeze(TENANT_ADMIN_OPERATIONAL_PERMISSIONS),
  strategy_editor: Object.freeze([
    ...TENANT_MEMBER_READ_PERMISSIONS,
    'strategy.manage',
    'knowledge.sources.manage',
    'content.briefs.manage',
  ]),
  content_editor: Object.freeze([
    ...TENANT_MEMBER_READ_PERMISSIONS,
    'knowledge.sources.manage',
    'content.briefs.manage',
    'content.production.manage',
  ]),
  reviewer: Object.freeze([
    ...TENANT_MEMBER_READ_PERMISSIONS,
    'knowledge.facts.verify',
    'review.decide',
  ]),
  publisher: Object.freeze([...TENANT_MEMBER_READ_PERMISSIONS, 'publishing.manage']),
  analyst: Object.freeze([...TENANT_MEMBER_READ_PERMISSIONS, 'analytics.read', 'cost.read']),
  viewer: Object.freeze(TENANT_MEMBER_READ_PERMISSIONS),
} as const satisfies Record<RoleCode, readonly PermissionCode[]>);

export function permissionsForRoles(roles: readonly RoleCode[]): ReadonlySet<PermissionCode> {
  const permissions = new Set<PermissionCode>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) permissions.add(permission);
  }
  return permissions;
}

export function roleHasPermission(role: RoleCode, permission: PermissionCode): boolean {
  return (ROLE_PERMISSIONS[role] as readonly PermissionCode[]).includes(permission);
}
