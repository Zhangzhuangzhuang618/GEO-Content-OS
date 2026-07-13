import { ERROR_DEFINITIONS } from '@geo-content-os/contracts';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '@geo-content-os/security';
import { Body, Controller, Get, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  buildIdempotencyScope,
  IdempotencyConflictError,
  IdempotencyKeyValidationError,
  IdempotencyProcessingError,
  IdempotencyService,
  parseIdempotencyKey,
  type JsonValue,
} from '../../../common/idempotency/index.js';
import { clearSessionCookie } from '../auth/auth.cookies.js';
import { AuthService } from '../auth/auth.service.js';
import { SwitchTenantRequestSchema } from './tenant-context.dto.js';
import { TenantContextNotFoundError } from './tenant-context.errors.js';
import { TenantContextService } from './tenant-context.service.js';

type TenantContextErrorCode =
  | 'AUTH_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID';

@Controller('auth')
export class TenantContextController {
  public constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(IdempotencyService) private readonly idempotencyService: IdempotencyService,
    @Inject(TenantContextService) private readonly tenantContextService: TenantContextService,
  ) {}

  @Get('tenants')
  public async list(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const principal = await this.authService.authenticateIdentitySession(
      request.cookies[SESSION_COOKIE_NAME],
    );
    if (!principal) {
      clearSessionCookie(reply);
      await sendError(reply, request.id, 'AUTH_REQUIRED');
      return;
    }
    const tenants = await this.tenantContextService.listAvailableTenants(
      principal.userId,
      principal.activeTenantId,
    );
    await reply.status(HttpStatus.OK).send({
      data: tenants,
      meta: { request_id: request.id },
    });
  }

  @Post('switch-tenant')
  public async switchTenant(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = SwitchTenantRequestSchema.safeParse(body);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const principal = await this.authService.authenticateIdentityWriteSession(
      request.cookies[SESSION_COOKIE_NAME],
      request.cookies[CSRF_COOKIE_NAME],
    );
    if (!principal) {
      clearSessionCookie(reply);
      await sendError(reply, request.id, 'AUTH_REQUIRED');
      return;
    }

    try {
      await this.tenantContextService.assertTenantAvailable(
        principal.userId,
        parsed.data.tenant_id,
      );
      const result = await this.idempotencyService.execute(
        {
          fingerprint: {
            body: parsed.data as JsonValue,
            method: request.method,
            path: '/auth/switch-tenant',
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: principal.userId,
            method: request.method,
            route: '/auth/switch-tenant',
          }),
          tenantId: parsed.data.tenant_id,
        },
        async () => {
          const session = await this.tenantContextService.switchTenant(
            principal.sessionId,
            principal.userId,
            parsed.data.tenant_id,
          );
          return {
            body: JSON.parse(
              JSON.stringify({ data: session, meta: { request_id: request.id } }),
            ) as JsonValue,
            statusCode: HttpStatus.OK,
          };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendTenantContextError(reply, request.id, error);
    }
  }
}

async function sendTenantContextError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof TenantContextNotFoundError) {
    await sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    return;
  }
  if (error instanceof IdempotencyConflictError) {
    await sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
    return;
  }
  if (error instanceof IdempotencyKeyValidationError) {
    await sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
    return;
  }
  if (error instanceof IdempotencyProcessingError) {
    await sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
    return;
  }
  throw error;
}

async function sendSchemaError(
  reply: FastifyReply,
  requestId: string,
  issues: readonly { readonly code: string; readonly path: PropertyKey[] }[],
): Promise<void> {
  await reply.status(HttpStatus.UNPROCESSABLE_ENTITY).send({
    error: {
      code: 'SCHEMA_VALIDATION_FAILED',
      details: { issues: issues.map((issue) => ({ code: issue.code, path: issue.path })) },
      message: ERROR_DEFINITIONS.SCHEMA_VALIDATION_FAILED.message,
      request_id: requestId,
    },
  });
}

async function sendError(
  reply: FastifyReply,
  requestId: string,
  code: TenantContextErrorCode,
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: {
      code,
      message: ERROR_DEFINITIONS[code].message,
      request_id: requestId,
    },
  });
}
