import { ERROR_DEFINITIONS } from '@geo-content-os/contracts';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '@geo-content-os/security';
import {
  Body,
  Controller,
  Delete,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
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
import { setCsrfCookie, setSessionCookie } from '../auth/auth.cookies.js';
import { AuthService } from '../auth/auth.service.js';
import {
  AcceptInvitationRequestSchema,
  CreateInvitationRequestSchema,
  InvitationIdSchema,
  InvitationTokenSchema,
} from './invitation.dto.js';
import {
  InvitationAuthenticationError,
  InvitationConflictError,
  InvitationNotFoundError,
  InvitationPermissionError,
} from './invitation.errors.js';
import { InvitationService } from './invitation.service.js';

type InvitationErrorCode =
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID'
  | 'TENANT_CONTEXT_REQUIRED';

@Controller('invitations')
export class InvitationController {
  public constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(IdempotencyService) private readonly idempotencyService: IdempotencyService,
    @Inject(InvitationService) private readonly invitationService: InvitationService,
  ) {}

  @Post()
  public async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = CreateInvitationRequestSchema.safeParse(body);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const principal = await this.authenticateTenantWrite(request, reply);
    if (!principal) return;

    try {
      const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key']);
      const result = await this.idempotencyService.execute(
        {
          fingerprint: {
            body: parsed.data as JsonValue,
            method: request.method,
            path: '/invitations',
          },
          idempotencyKey,
          scopeKey: buildIdempotencyScope({
            actorId: principal.userId,
            method: request.method,
            route: '/invitations',
          }),
          tenantId: principal.tenantId,
          ttlMs: 72 * 60 * 60 * 1_000,
        },
        async () => {
          const invitation = await this.invitationService.create({
            actorUserId: principal.userId,
            request: parsed.data,
            tenantId: principal.tenantId,
          });
          return {
            body: JSON.parse(
              JSON.stringify({ data: invitation, meta: { request_id: request.id } }),
            ) as JsonValue,
            statusCode: HttpStatus.CREATED,
          };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendInvitationError(reply, request.id, error);
    }
  }

  @Post(':token/accept')
  public async accept(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedToken = InvitationTokenSchema.safeParse(token);
    const parsedBody = AcceptInvitationRequestSchema.safeParse(body);
    if (!parsedToken.success || !parsedBody.success) {
      await sendSchemaError(reply, request.id, [
        ...(parsedToken.success ? [] : parsedToken.error.issues),
        ...(parsedBody.success ? [] : parsedBody.error.issues),
      ]);
      return;
    }

    try {
      const result = await this.invitationService.accept({
        context: {
          ip: request.ip,
          ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
        },
        displayName: parsedBody.data.display_name,
        password: parsedBody.data.password,
        token: parsedToken.data,
      });
      setSessionCookie(reply, result.sessionToken, result.ttlSeconds);
      setCsrfCookie(reply, result.csrfToken, result.ttlSeconds);
      await reply.status(HttpStatus.OK).send({
        data: result.view,
        meta: { request_id: request.id },
      });
    } catch (error) {
      await sendInvitationError(reply, request.id, error);
    }
  }

  @Delete(':id')
  public async revoke(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = InvitationIdSchema.safeParse(id);
    if (!parsedId.success) {
      await sendSchemaError(reply, request.id, parsedId.error.issues);
      return;
    }
    const principal = await this.authenticateTenantWrite(request, reply);
    if (!principal) return;

    try {
      await this.invitationService.revoke(principal.userId, principal.tenantId, parsedId.data);
      await reply.status(HttpStatus.NO_CONTENT).send();
    } catch (error) {
      await sendInvitationError(reply, request.id, error);
    }
  }

  private async authenticateTenantWrite(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ readonly tenantId: string; readonly userId: string } | undefined> {
    const principal = await this.authService.authenticateWriteSession(
      request.cookies[SESSION_COOKIE_NAME],
      request.cookies[CSRF_COOKIE_NAME],
    );
    if (!principal) {
      await sendError(reply, request.id, 'AUTH_REQUIRED');
      return undefined;
    }
    if (!principal.activeTenantId) {
      await sendError(reply, request.id, 'TENANT_CONTEXT_REQUIRED');
      return undefined;
    }
    return { tenantId: principal.activeTenantId, userId: principal.userId };
  }
}

async function sendInvitationError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof InvitationPermissionError) {
    await sendError(reply, requestId, 'PERMISSION_DENIED');
    return;
  }
  if (error instanceof InvitationConflictError) {
    await sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
    return;
  }
  if (error instanceof InvitationNotFoundError) {
    await sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    return;
  }
  if (error instanceof InvitationAuthenticationError) {
    await sendError(reply, requestId, 'AUTH_REQUIRED');
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
  code: InvitationErrorCode | 'IDEMPOTENCY_CONFLICT',
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: {
      code,
      message: ERROR_DEFINITIONS[code].message,
      request_id: requestId,
    },
  });
}
