import {
  BriefIdSchema,
  BriefListQuerySchema,
  CreateBriefRequestSchema,
  ERROR_DEFINITIONS,
  UpdateBriefRequestSchema,
} from '@geo-content-os/contracts';
import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  Patch,
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
  BriefNotFoundError,
  BriefStateError,
  BriefValidationError,
  BriefVersionConflictError,
} from './brief.errors.js';
import { BriefService } from './brief.service.js';

type BriefErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID'
  | 'VERSION_CONFLICT';

@Controller('briefs')
@UseGuards(PolicyGuard)
export class BriefController {
  public constructor(
    @Inject(BriefService) private readonly briefService: BriefService,
    @Inject(IdempotencyService) private readonly idempotencyService: IdempotencyService,
  ) {}

  @Post()
  @RequirePermissions('content.briefs.manage')
  public async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = CreateBriefRequestSchema.safeParse(body);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    const policy = requireTenantPolicy(request);
    try {
      const result = await this.idempotencyService.execute(
        {
          fingerprint: {
            body: parsed.data as JsonValue,
            method: request.method,
            path: '/briefs',
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: policy.userId,
            method: request.method,
            route: '/briefs',
          }),
          tenantId: policy.tenantId,
        },
        async (transaction) => {
          const brief = await this.briefService.create(
            transaction,
            policy.tenantId,
            policy.userId,
            parsed.data,
            auditContext(request),
          );
          return {
            body: toJson({ data: brief, meta: { request_id: request.id } }),
            statusCode: HttpStatus.CREATED,
          };
        },
      );
      await reply
        .header('ETag', quoteVersion(readResponseVersion(result.response.body)))
        .status(result.response.statusCode)
        .send(result.response.body);
    } catch (error) {
      await sendBriefError(reply, request.id, error);
    }
  }

  @Get()
  @RequirePermissions('content.read')
  public async list(
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = BriefListQuerySchema.safeParse(query);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requireTenantPolicy(request);
      const page = await this.briefService.list(policy.tenantId, policy.userId, parsed.data);
      await reply.status(HttpStatus.OK).send({
        data: page.items,
        meta: { next_cursor: page.nextCursor, request_id: request.id },
      });
    } catch (error) {
      await sendBriefError(reply, request.id, error);
    }
  }

  @Get(':id')
  @RequirePermissions('content.read')
  public async find(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = BriefIdSchema.safeParse(id);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requireTenantPolicy(request);
      const brief = await this.briefService.find(policy.tenantId, policy.userId, parsed.data);
      await reply
        .header('ETag', quoteVersion(brief.version))
        .status(HttpStatus.OK)
        .send({ data: brief, meta: { request_id: request.id } });
    } catch (error) {
      await sendBriefError(reply, request.id, error);
    }
  }

  @Patch(':id')
  @RequirePermissions('content.briefs.manage')
  public async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = BriefIdSchema.safeParse(id);
    const parsedBody = UpdateBriefRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, [
        ...(parsedId.success ? [] : parsedId.error.issues),
        ...(parsedBody.success ? [] : parsedBody.error.issues),
      ]);
    }
    const policy = requireTenantPolicy(request);
    try {
      const expectedVersion = parseIfMatch(request.headers['if-match']);
      const route = `/briefs/${parsedId.data}`;
      const result = await this.idempotencyService.execute(
        {
          fingerprint: {
            body: parsedBody.data as JsonValue,
            method: request.method,
            path: route,
            query: { version: expectedVersion },
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
          const brief = await this.briefService.update(
            transaction,
            policy.tenantId,
            policy.userId,
            parsedId.data,
            expectedVersion,
            parsedBody.data,
            auditContext(request),
          );
          return {
            body: toJson({ data: brief, meta: { request_id: request.id } }),
            statusCode: HttpStatus.OK,
          };
        },
      );
      await reply
        .header('ETag', quoteVersion(readResponseVersion(result.response.body)))
        .status(result.response.statusCode)
        .send(result.response.body);
    } catch (error) {
      await sendBriefError(reply, request.id, error);
    }
  }
}

function requireTenantPolicy(request: FastifyRequest): { tenantId: string; userId: string } {
  const policy = getPolicyContext(request);
  if (!policy?.activeTenantId) {
    throw new Error('PolicyGuard did not attach an active tenant PolicyContext');
  }
  return { tenantId: policy.activeTenantId, userId: policy.userId };
}

function parseIfMatch(value: string | string[] | undefined): number {
  if (Array.isArray(value) || typeof value !== 'string') {
    throw new BriefValidationError('If-Match must contain the current Brief version');
  }
  const normalized = value.trim();
  if (normalized.startsWith('W/')) {
    throw new BriefValidationError('Weak If-Match values are not supported');
  }
  const match = /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/u.exec(normalized);
  const version = Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new BriefValidationError('If-Match must be a positive integer version');
  }
  return version;
}

function quoteVersion(version: number): string {
  return `"${version}"`;
}

function readResponseVersion(body: JsonValue): number {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Brief response is missing its version');
  }
  const response = body as { readonly [key: string]: JsonValue };
  const data = response['data'];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Brief response is missing its data object');
  }
  const record = data as { readonly [key: string]: JsonValue };
  const version = record['version'];
  if (!Number.isSafeInteger(version) || (version as number) <= 0) {
    throw new Error('Brief response has an invalid version');
  }
  return version as number;
}

function auditContext(request: FastifyRequest): { ip?: string; requestId: string } {
  return { ...(request.ip ? { ip: request.ip } : {}), requestId: request.id };
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function sendBriefError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof BriefNotFoundError) return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
  if (error instanceof BriefVersionConflictError) {
    return sendError(reply, requestId, 'VERSION_CONFLICT');
  }
  if (error instanceof BriefValidationError || error instanceof IdempotencyKeyValidationError) {
    return sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
  }
  if (
    error instanceof BriefStateError ||
    error instanceof IdempotencyProcessingError ||
    isDatabaseConstraintError(error)
  ) {
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
  }
  if (error instanceof IdempotencyConflictError) {
    return sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
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
  code: BriefErrorCode,
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: { code, message: ERROR_DEFINITIONS[code].message, request_id: requestId },
  });
}
