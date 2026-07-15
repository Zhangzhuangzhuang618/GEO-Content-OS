import {
  CreateKeywordSetRequestSchema,
  ERROR_DEFINITIONS,
  KeywordSetIdSchema,
  KeywordSetQuerySchema,
  UpsertKeywordsRequestSchema,
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
  KeywordNotFoundError,
  KeywordStateError,
  KeywordValidationError,
} from './keyword.errors.js';
import { KeywordService } from './keyword.service.js';

type KeywordErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID';

@Controller('keyword-sets')
@UseGuards(PolicyGuard)
export class KeywordController {
  public constructor(
    @Inject(IdempotencyService) private readonly idempotencyService: IdempotencyService,
    @Inject(KeywordService) private readonly keywordService: KeywordService,
  ) {}

  @Get()
  @RequirePermissions('strategy.read')
  public async list(
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = KeywordSetQuerySchema.safeParse(query);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const page = await this.keywordService.list(policy.tenantId, policy.userId, parsed.data);
      await reply.status(HttpStatus.OK).send({
        data: page.items,
        meta: { next_cursor: page.nextCursor, request_id: request.id },
      });
    } catch (error) {
      await sendKeywordError(reply, request.id, error);
    }
  }

  @Get(':id')
  @RequirePermissions('strategy.read')
  public async find(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = KeywordSetIdSchema.safeParse(id);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const keywordSet = await this.keywordService.find(
        policy.tenantId,
        policy.userId,
        parsed.data,
      );
      await reply
        .status(HttpStatus.OK)
        .send({ data: keywordSet, meta: { request_id: request.id } });
    } catch (error) {
      await sendKeywordError(reply, request.id, error);
    }
  }

  @Post()
  @RequirePermissions('strategy.manage')
  public async createSet(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = CreateKeywordSetRequestSchema.safeParse(body);
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
            path: '/keyword-sets',
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: policy.userId,
            method: request.method,
            route: '/keyword-sets',
          }),
          tenantId: policy.tenantId,
        },
        async (transaction) => {
          const keywordSet = await this.keywordService.createSet(
            transaction,
            policy.tenantId,
            policy.userId,
            parsed.data,
            auditContext(request),
          );
          return {
            body: toJson({ data: keywordSet, meta: { request_id: request.id } }),
            statusCode: HttpStatus.CREATED,
          };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendKeywordError(reply, request.id, error);
    }
  }

  @Post(':id/keywords')
  @RequirePermissions('strategy.manage')
  public async upsert(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = KeywordSetIdSchema.safeParse(id);
    const parsedBody = UpsertKeywordsRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success) {
      await sendSchemaError(reply, request.id, [
        ...(parsedId.success ? [] : parsedId.error.issues),
        ...(parsedBody.success ? [] : parsedBody.error.issues),
      ]);
      return;
    }
    const policy = requireTenantPolicy(request);
    const route = `/keyword-sets/${parsedId.data}/keywords`;
    try {
      const result = await this.idempotencyService.execute(
        {
          fingerprint: {
            body: parsedBody.data as JsonValue,
            method: request.method,
            path: route,
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: policy.userId,
            method: request.method,
            route,
          }),
          tenantId: policy.tenantId,
        },
        async (transaction) => {
          const keywords = await this.keywordService.upsert(
            transaction,
            policy.tenantId,
            policy.userId,
            parsedId.data,
            parsedBody.data.keywords,
            auditContext(request),
          );
          return {
            body: toJson({ data: keywords, meta: { request_id: request.id } }),
            statusCode: HttpStatus.OK,
          };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendKeywordError(reply, request.id, error);
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

function auditContext(request: FastifyRequest): {
  readonly ip?: string;
  readonly requestId: string;
} {
  return { ...(request.ip ? { ip: request.ip } : {}), requestId: request.id };
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function sendKeywordError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof KeywordNotFoundError) {
    await sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    return;
  }
  if (error instanceof KeywordValidationError) {
    await sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
    return;
  }
  if (error instanceof KeywordStateError || isDatabaseConstraintError(error)) {
    await sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
    return;
  }
  if (error instanceof IdempotencyKeyValidationError) {
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
  code: KeywordErrorCode,
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: { code, message: ERROR_DEFINITIONS[code].message, request_id: requestId },
  });
}
