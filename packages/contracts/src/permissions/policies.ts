import type { PermissionCode } from './codes.js';

export const POLICY_CODES = Object.freeze([
  'platform_admin',
  'platform_operator',
  'tenant_member',
  'tenant_admin_or_owner',
  'strategy_editor_or_admin',
  'strategy_or_content_editor_or_admin',
  'content_editor_or_admin',
  'reviewer_or_admin',
  'publisher_or_admin',
  'analyst_or_admin',
  'owner_or_analyst_or_admin',
  'tenant_owner',
] as const);

export type PolicyCode = (typeof POLICY_CODES)[number];

export const POLICY_PERMISSIONS = Object.freeze({
  platform_admin: Object.freeze(['platform.tenants.manage']),
  platform_operator: Object.freeze(['platform.rules.manage']),
  tenant_member: Object.freeze(['tenant.profile.read']),
  tenant_admin_or_owner: Object.freeze(['tenant.members.manage']),
  strategy_editor_or_admin: Object.freeze(['strategy.manage']),
  strategy_or_content_editor_or_admin: Object.freeze(['knowledge.sources.manage']),
  content_editor_or_admin: Object.freeze(['content.production.manage']),
  reviewer_or_admin: Object.freeze(['review.decide']),
  publisher_or_admin: Object.freeze(['publishing.manage']),
  analyst_or_admin: Object.freeze(['analytics.read']),
  owner_or_analyst_or_admin: Object.freeze(['cost.read']),
  tenant_owner: Object.freeze(['audit.export']),
} as const satisfies Record<PolicyCode, readonly PermissionCode[]>);
