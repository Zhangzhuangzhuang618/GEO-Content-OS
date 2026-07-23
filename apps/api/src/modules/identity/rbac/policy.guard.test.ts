import { permissionsForRoles, type RoleCode } from '@geo-content-os/contracts';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AuthService, AuthSessionPrincipal } from '../auth/auth.service.js';
import { getPolicyContext } from './policy-context.store.js';
import { PolicyGuard } from './policy.guard.js';
import type { PolicyContext, PolicyRequirement } from './policy.types.js';
import type { RbacService } from './rbac.service.js';

const PRINCIPAL: AuthSessionPrincipal = {
  activeTenantId: '20000000-0000-4000-8000-000000000018',
  sessionId: '30000000-0000-4000-8000-000000000018',
  userId: '10000000-0000-4000-8000-000000000018',
};

describe('PolicyGuard', () => {
  it('does not authenticate routes without policy metadata', async () => {
    const fixture = createFixture(undefined, contextFor(['viewer']));
    await expect(fixture.guard.canActivate(fixture.executionContext)).resolves.toBe(true);
    expect(fixture.authenticateReadSession).not.toHaveBeenCalled();
  });

  it('combines explicit platform and tenant roles and stores the authorized context', async () => {
    const context = contextFor(['platform_operator', 'content_editor']);
    const fixture = createFixture(
      { mode: 'all', permissions: ['platform.prompts.manage', 'content.production.manage'] },
      context,
    );

    await expect(fixture.guard.canActivate(fixture.executionContext)).resolves.toBe(true);
    expect(fixture.authenticateReadSession).toHaveBeenCalledOnce();
    expect(getPolicyContext(fixture.request)).toBe(context);
  });

  it('never treats platform_admin as implicit tenant-content access', async () => {
    const fixture = createFixture(
      { mode: 'all', permissions: ['content.read'] },
      contextFor(['platform_admin'], null),
    );

    const error = await captureError(() => fixture.guard.canActivate(fixture.executionContext));
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      error: { code: 'TENANT_CONTEXT_REQUIRED', request_id: 'rbac-request' },
    });
  });

  it('returns permission denied when an active tenant role lacks the action', async () => {
    const fixture = createFixture(
      { mode: 'all', permissions: ['strategy.manage'] },
      contextFor(['viewer']),
    );

    const error = await captureError(() => fixture.guard.canActivate(fixture.executionContext));
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      error: { code: 'PERMISSION_DENIED', request_id: 'rbac-request' },
    });
  });

  it('supports any-mode policies and uses CSRF-backed auth for unsafe methods', async () => {
    const fixture = createFixture(
      { mode: 'any', permissions: ['review.decide', 'publishing.manage'] },
      contextFor(['reviewer']),
      'POST',
    );

    await expect(fixture.guard.canActivate(fixture.executionContext)).resolves.toBe(true);
    expect(fixture.authenticateWriteSession).toHaveBeenCalledWith('session-token', 'csrf-token');
    expect(fixture.authenticateReadSession).not.toHaveBeenCalled();
  });
});

function createFixture(
  requirement: PolicyRequirement | undefined,
  policyContext: PolicyContext,
  method = 'GET',
) {
  const authenticateReadSession = vi.fn(() => Promise.resolve(PRINCIPAL));
  const authenticateWriteSession = vi.fn(() => Promise.resolve(PRINCIPAL));
  const authService = {
    authenticateReadSession,
    authenticateWriteSession,
  } as unknown as AuthService;
  const rbacService = {
    resolve: vi.fn(() => Promise.resolve(policyContext)),
  } as unknown as RbacService;
  const reflector = {
    getAllAndOverride: vi.fn(() => requirement),
  } as unknown as Reflector;
  const request = {
    cookies: { geo_csrf: 'csrf-token', geo_session: 'session-token' },
    id: 'rbac-request',
    method,
  } as unknown as FastifyRequest;
  const executionContext = {
    getClass: () => class TestController {},
    getHandler: () => function testHandler() {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return {
    authenticateReadSession,
    authenticateWriteSession,
    executionContext,
    guard: new PolicyGuard(authService, rbacService, reflector),
    request,
  };
}

function contextFor(
  roles: readonly RoleCode[],
  activeTenantId = PRINCIPAL.activeTenantId,
): PolicyContext {
  const tenantRole = roles.find((role) => !role.startsWith('platform_')) ?? null;
  return {
    activeTenantId,
    permissions: permissionsForRoles(roles),
    platformRoles: roles.filter((role) =>
      role.startsWith('platform_'),
    ) as PolicyContext['platformRoles'],
    roles,
    sessionId: PRINCIPAL.sessionId,
    tenantRole: tenantRole as PolicyContext['tenantRole'],
    userId: PRINCIPAL.userId,
  };
}

async function captureError(operation: () => Promise<boolean>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected policy guard to reject the request');
}
