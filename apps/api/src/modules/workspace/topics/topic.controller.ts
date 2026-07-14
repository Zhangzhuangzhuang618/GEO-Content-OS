import {
  AdoptTopicRequestSchema,
  ERROR_DEFINITIONS,
  TopicCandidateIdSchema,
  TopicCandidateQuerySchema,
  TopicPlanRequestSchema,
} from '@geo-content-os/contracts';
import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
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
import { getPolicyContext, PolicyGuard, RequirePermissions } from '../../identity/rbac/index.js';
import {
  TopicNotFoundError,
  TopicStateError,
  TopicValidationError,
  TopicVersionConflictError,
} from './topic.errors.js';
import { TopicService } from './topic.service.js';

type TopicErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID'
  | 'VERSION_CONFLICT';

@Controller('topic-plans')
@UseGuards(PolicyGuard)
export class TopicPlanController {
  public constructor(
    @Inject(IdempotencyService) private readonly idempotencyService: IdempotencyService,
    @Inject(TopicService) private readonly topicService: TopicService,
  ) {}

  @Post('generate')
  @RequirePermissions('strategy.manage')
  public async generate(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = TopicPlanRequestSchema.safeParse(body);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const result = await this.idempotencyService.execute(
        {
          fingerprint: {
            body: parsed.data as JsonValue,
            method: request.method,
            path: '/topic-plans/generate',
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: policy.userId,
            method: request.method,
            route: '/topic-plans/generate',
          }),
          tenantId: policy.tenantId,
        },
        async (transaction) => {
          const run = await this.topicService.requestPlan(
            transaction,
            policy.tenantId,
            policy.userId,
            parsed.data,
            auditContext(request),
          );
          return {
            body: toJson({ data: run, meta: { request_id: request.id } }),
            statusCode: HttpStatus.ACCEPTED,
          };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendTopicError(reply, request.id, error);
    }
  }
}

@Controller('topic-candidates')
@UseGuards(PolicyGuard)
export class TopicCandidateController {
  public constructor(@Inject(TopicService) private readonly topicService: TopicService) {}

  @Get()
  @RequirePermissions('strategy.read')
  public async list(
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = TopicCandidateQuerySchema.safeParse(query);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const page = await this.topicService.list(policy.tenantId, policy.userId, parsed.data);
      await reply.status(HttpStatus.OK).send({
        data: page.items,
        meta: { next_cursor: page.nextCursor, request_id: request.id },
      });
    } catch (error) {
      await sendTopicError(reply, request.id, error);
    }
  }

  @Post(':id/adopt')
  @RequirePermissions('strategy.manage')
  public async adopt(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = TopicCandidateIdSchema.safeParse(id);
    const parsedBody = AdoptTopicRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success) {
      await sendSchemaError(reply, request.id, [
        ...(parsedId.success ? [] : parsedId.error.issues),
        ...(parsedBody.success ? [] : parsedBody.error.issues),
      ]);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const brief = await this.topicService.adopt(
        policy.tenantId,
        policy.userId,
        parsedId.data,
        parseIfMatch(request.headers['if-match']),
        parsedBody.data,
        auditContext(request),
      );
      await reply
        .header('ETag', `"${brief.version}"`)
        .status(HttpStatus.OK)
        .send({ data: brief, meta: { request_id: request.id } });
    } catch (error) {
      await sendTopicError(reply, request.id, error);
    }
  }
}

function requireTenantPolicy(request: FastifyRequest): {
  readonly tenantId: string;
  readonly userId: string;
} {
  const policy = getPolicyContext(request);
  if (!policy?.activeTenantId) {
    throw new Error('PolicyGuard did not attach an active tenant PolicyContext');
  }
  return { tenantId: policy.activeTenantId, userId: policy.userId };
}

function parseIfMatch(value: string | string[] | undefined): number {
  if (Array.isArray(value) || typeof value !== 'string') {
    throw new TopicValidationError('If-Match must contain the current topic version');
  }
  const normalized = value.trim();
  if (normalized.startsWith('W/')) {
    throw new TopicValidationError('Weak If-Match values are not supported');
  }
  const match = /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/u.exec(normalized);
  const version = Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new TopicValidationError('If-Match must be a positive integer version');
  }
  return version;
}

function auditContext(request: FastifyRequest): {
  readonly ip?: string;
  readonly requestId: string;
} {
  return { ...(request.ip ? { ip: request.ip } : {}), requestId: request.id };
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function sendTopicError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof TopicNotFoundError) {
    await sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    return;
  }
  if (error instanceof TopicVersionConflictError) {
    await sendError(reply, requestId, 'VERSION_CONFLICT');
    return;
  }
  if (error instanceof TopicStateError || isDatabaseConstraintError(error)) {
    await sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
    return;
  }
  if (error instanceof TopicValidationError || error instanceof IdempotencyKeyValidationError) {
    await sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
    return;
  }
  if (error instanceof IdempotencyConflictError) {
    await sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
    return;
  }
  if (error instanceof IdempotencyProcessingError) {
    await sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
    return;
  }
  throw error;
}

function isDatabaseConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === '23503' || code === '23505' || code === '23514';
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
  code: TopicErrorCode,
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: { code, message: ERROR_DEFINITIONS[code].message, request_id: requestId },
  });
}
