export const PERMISSION_CODES = Object.freeze([
  'platform.tenants.manage',
  'platform.support_access.manage',
  'platform.models.manage',
  'platform.rules.manage',
  'platform.prompts.manage',
  'platform.runs.monitor',
  'platform.audit.read',
  'tenant.profile.read',
  'tenant.profile.manage',
  'tenant.billing.read',
  'tenant.billing.manage',
  'tenant.members.read',
  'tenant.members.manage',
  'tenant.workspaces.read',
  'tenant.workspaces.manage',
  'strategy.read',
  'strategy.manage',
  'knowledge.read',
  'knowledge.sources.manage',
  'knowledge.facts.verify',
  'content.read',
  'content.briefs.manage',
  'content.production.manage',
  'review.read',
  'review.decide',
  'publishing.read',
  'publishing.manage',
  'analytics.read',
  'cost.read',
  'cost.rates.read',
  'audit.read',
  'audit.export',
] as const);

export type PermissionCode = (typeof PERMISSION_CODES)[number];

export function isPermissionCode(value: string): value is PermissionCode {
  return (PERMISSION_CODES as readonly string[]).includes(value);
}

export function isTenantPermission(permission: PermissionCode): boolean {
  return !permission.startsWith('platform.');
}
