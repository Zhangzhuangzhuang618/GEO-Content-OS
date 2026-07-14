import { ERROR_DEFINITIONS } from '@geo-content-os/contracts';
import {
  Body,
  Controller,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { getPolicyContext, PolicyGuard, RequirePermissions } from '../../../identity/rbac/index.js';
import { FactIdSchema, VerifyFactRequestSchema } from './fact-adjudication.dto.js';
import {
  FactAdjudicationNotFoundError,
  FactAdjudicationStateError,
  FactAdjudicationValidationError,
  FactAdjudicationVersionConflictError,
} from './fact-adjudication.errors.js';
import { FactAdjudicationService } from './fact-adjudication.service.js';

type FactAdjudicationErrorCode =
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID'
  | 'VERSION_CONFLICT';

@Controller('facts')
@UseGuards(PolicyGuard)
export class FactAdjudicationController {
  public constructor(
    @Inject(FactAdjudicationService)
    private readonly factAdjudicationService: FactAdjudicationService,
  ) {}

  @Post(':id/verify')
  @RequirePermissions('knowledge.facts.verify', 'review.decide')
  public async adjudicate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = FactIdSchema.safeParse(id);
    const parsedBody = VerifyFactRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success) {
      await sendSchemaError(reply, request.id, [
        ...(parsedId.success ? [] : parsedId.error.issues),
        ...(parsedBody.success ? [] : parsedBody.error.issues),
      ]);
      return;
    }
    try {
      assertIfMatch(request.headers['if-match'], parsedBody.data.expected_updated_at);
      const policy = getPolicyContext(request);
      if (!policy?.activeTenantId) {
        throw new Error('PolicyGuard did not attach an active tenant PolicyContext');
      }
      const fact = await this.factAdjudicationService.adjudicate(
        policy.activeTenantId,
        policy.userId,
        parsedId.data,
        parsedBody.data,
        { ...(request.ip ? { ip: request.ip } : {}), requestId: request.id },
      );
      await reply
        .header('ETag', quoteRevision(fact.updated_at))
        .status(HttpStatus.OK)
        .send({ data: fact, meta: { request_id: request.id } });
    } catch (error) {
      await sendFactAdjudicationError(reply, request.id, error);
    }
  }
}

function assertIfMatch(value: string | string[] | undefined, expectedUpdatedAt: string): void {
  if (value === undefined) return;
  if (Array.isArray(value) || typeof value !== 'string' || value.startsWith('W/')) {
    throw new FactAdjudicationValidationError('If-Match must be one strong fact revision');
  }
  const normalized = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  if (normalized !== expectedUpdatedAt) throw new FactAdjudicationVersionConflictError();
}

function quoteRevision(updatedAt: string): string {
  return `"${updatedAt}"`;
}

async function sendFactAdjudicationError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof FactAdjudicationNotFoundError) {
    await sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    return;
  }
  if (error instanceof FactAdjudicationVersionConflictError) {
    await sendError(reply, requestId, 'VERSION_CONFLICT');
    return;
  }
  if (error instanceof FactAdjudicationStateError || isDatabaseConstraintError(error)) {
    await sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
    return;
  }
  if (error instanceof FactAdjudicationValidationError) {
    await sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
    return;
  }
  throw error;
}

function isDatabaseConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return ['23503', '23505', '23514'].includes(String((error as { readonly code?: unknown }).code));
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
  code: FactAdjudicationErrorCode,
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: { code, message: ERROR_DEFINITIONS[code].message, request_id: requestId },
  });
}
