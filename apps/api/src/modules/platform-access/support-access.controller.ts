import { ERROR_DEFINITIONS } from '@geo-content-os/contracts';
import { Body, Controller, HttpStatus, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  buildIdempotencyScope,
  IdempotencyConflictError,
  IdempotencyKeyValidationError,
  IdempotencyProcessingError,
  IdempotencyService,
  parseIdempotencyKey,
  type JsonValue,
} from '../../common/idempotency/index.js';
import { getPolicyContext, PolicyGuard, RequirePolicy } from '../identity/rbac/index.js';
import { SupportGrantRequestSchema } from './support-access.dto.js';
import {
  SupportAccessNotFoundError,
  SupportAccessValidationError,
} from './support-access.errors.js';
import { SupportAccessService } from './support-access.service.js';

type SupportAccessErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID';

@Controller('platform/support-access-grants')
@UseGuards(PolicyGuard)
@RequirePolicy('platform_admin')
export class SupportAccessController {
  public constructor(
    @Inject(IdempotencyService) private readonly idempotencyService: IdempotencyService,
    @Inject(SupportAccessService) private readonly supportAccessService: SupportAccessService,
  ) {}

  @Post()
  public async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = SupportGrantRequestSchema.safeParse(body);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const policyContext = getPolicyContext(request);
    if (!policyContext) throw new Error('PolicyGuard did not attach a PolicyContext');

    try {
      const result = await this.idempotencyService.execute(
        {
          fingerprint: {
            body: parsed.data as JsonValue,
            method: request.method,
            path: '/platform/support-access-grants',
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: policyContext.userId,
            method: request.method,
            route: '/platform/support-access-grants',
          }),
          tenantId: parsed.data.tenant_id,
        },
        async () => {
          const grant = await this.supportAccessService.createGrant(
            policyContext.userId,
            parsed.data,
            {
              ip: request.ip,
              requestId: request.id,
            },
          );
          return {
            body: JSON.parse(
              JSON.stringify({ data: grant, meta: { request_id: request.id } }),
            ) as JsonValue,
            statusCode: HttpStatus.CREATED,
          };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendSupportAccessError(reply, request.id, error);
    }
  }
}

async function sendSupportAccessError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof SupportAccessNotFoundError) {
    await sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    return;
  }
  if (error instanceof SupportAccessValidationError) {
    await sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
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
  code: SupportAccessErrorCode,
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: {
      code,
      message: ERROR_DEFINITIONS[code].message,
      request_id: requestId,
    },
  });
}
