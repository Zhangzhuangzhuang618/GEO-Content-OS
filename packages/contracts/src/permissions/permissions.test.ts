import { describe, expect, it } from 'vitest';

import { PERMISSION_CODES, isPermissionCode, isTenantPermission } from './codes.js';
import { POLICY_PERMISSIONS } from './policies.js';
import { permissionsForRoles, roleHasPermission, ROLE_PERMISSIONS } from './role-permissions.js';

describe('shared RBAC permissions', () => {
  it('keeps permission codes unique, namespaced, and runtime-checkable', () => {
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
    expect(PERMISSION_CODES.every((code) => /^[a-z_]+(?:\.[a-z_]+)+$/u.test(code))).toBe(true);
    expect(isPermissionCode('content.production.manage')).toBe(true);
    expect(isPermissionCode('content.delete_everything')).toBe(false);
    expect(isTenantPermission('tenant.profile.read')).toBe(true);
    expect(isTenantPermission('platform.tenants.manage')).toBe(false);
  });

  it('does not grant platform roles implicit tenant-content access', () => {
    const platformPermissions = permissionsForRoles(['platform_admin', 'platform_operator']);
    expect([...platformPermissions].every((permission) => permission.startsWith('platform.'))).toBe(
      true,
    );
    expect(platformPermissions.has('content.read')).toBe(false);
    expect(platformPermissions.has('audit.export')).toBe(false);
  });

  it('implements the frozen tenant role combinations without privilege escalation', () => {
    expect(roleHasPermission('strategy_editor', 'strategy.manage')).toBe(true);
    expect(roleHasPermission('strategy_editor', 'content.production.manage')).toBe(false);
    expect(roleHasPermission('content_editor', 'knowledge.sources.manage')).toBe(true);
    expect(roleHasPermission('content_editor', 'review.decide')).toBe(false);
    expect(roleHasPermission('reviewer', 'review.decide')).toBe(true);
    expect(roleHasPermission('publisher', 'publishing.manage')).toBe(true);
    expect(roleHasPermission('analyst', 'cost.read')).toBe(true);
    expect(roleHasPermission('viewer', 'tenant.profile.read')).toBe(true);
    expect(roleHasPermission('viewer', 'strategy.manage')).toBe(false);
    expect(roleHasPermission('tenant_admin', 'tenant.billing.manage')).toBe(false);
    expect(roleHasPermission('tenant_admin', 'audit.read')).toBe(false);
    expect(roleHasPermission('tenant_owner', 'audit.read')).toBe(true);
    expect(roleHasPermission('tenant_owner', 'audit.export')).toBe(true);
  });

  it('maps every named frozen policy to declared permission codes', () => {
    const declared = new Set(PERMISSION_CODES);
    for (const permissions of Object.values(POLICY_PERMISSIONS)) {
      expect(permissions.length).toBeGreaterThan(0);
      expect(permissions.every((permission) => declared.has(permission))).toBe(true);
    }
    expect(Object.keys(ROLE_PERMISSIONS)).toHaveLength(10);
  });
});
