import { ERROR_DEFINITIONS, isTenantPermission } from '@geo-content-os/contracts';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '@geo-content-os/security';
import type { FastifyRequest } from 'fastify';

import { AuthService } from '../auth/auth.service.js';
import { setPolicyContext } from './policy-context.store.js';
import { POLICY_REQUIREMENT_METADATA } from './policy.decorator.js';
import type { PolicyContext, PolicyRequirement } from './policy.types.js';
import { RbacService } from './rbac.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class PolicyGuard implements CanActivate {
  public constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(RbacService) private readonly rbacService: RbacService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  public async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<PolicyRequirement>(
      POLICY_REQUIREMENT_METADATA,
      [executionContext.getHandler(), executionContext.getClass()],
    );
    if (!requirement) return true;

    const request = executionContext.switchToHttp().getRequest<FastifyRequest>();
    const principal = SAFE_METHODS.has(request.method.toUpperCase())
      ? await this.authService.authenticateReadSession(request.cookies[SESSION_COOKIE_NAME])
      : await this.authService.authenticateWriteSession(
          request.cookies[SESSION_COOKIE_NAME],
          request.cookies[CSRF_COOKIE_NAME],
        );
    if (!principal) throwPolicyError('AUTH_REQUIRED', request.id);

    const policyContext = await this.rbacService.resolve(principal);
    if (isAllowed(policyContext, requirement)) {
      setPolicyContext(request, policyContext);
      return true;
    }
    if (
      !policyContext.activeTenantId &&
      requirement.permissions.some((permission) => isTenantPermission(permission))
    ) {
      throwPolicyError('TENANT_CONTEXT_REQUIRED', request.id);
    }
    throwPolicyError('PERMISSION_DENIED', request.id);
  }
}

function isAllowed(context: PolicyContext, requirement: PolicyRequirement): boolean {
  if (requirement.mode === 'all') {
    return requirement.permissions.every((permission) => context.permissions.has(permission));
  }
  return requirement.permissions.some((permission) => context.permissions.has(permission));
}

function throwPolicyError(
  code: 'AUTH_REQUIRED' | 'PERMISSION_DENIED' | 'TENANT_CONTEXT_REQUIRED',
  requestId: string,
): never {
  const body = {
    error: {
      code,
      message: ERROR_DEFINITIONS[code].message,
      request_id: requestId,
    },
  };
  if (code === 'AUTH_REQUIRED') throw new UnauthorizedException(body);
  throw new ForbiddenException(body);
}
