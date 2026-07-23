import {
  BrandProfileIdSchema,
  BrandProfileQuerySchema,
  CreateBrandProfileRequestSchema,
  ERROR_DEFINITIONS,
  PublishVersionRequestSchema,
  ReasonRequestSchema,
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
  BrandProfileNotFoundError,
  BrandProfileStateError,
  BrandProfileValidationError,
  BrandProfileVersionConflictError,
} from './brand-profile.errors.js';
import { BrandProfileService } from './brand-profile.service.js';

type BrandProfileErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID'
  | 'VERSION_CONFLICT';

@Controller('brand-profiles')
@UseGuards(PolicyGuard)
export class BrandProfileController {
  public constructor(
    @Inject(BrandProfileService) private readonly brandProfileService: BrandProfileService,
    @Inject(IdempotencyService) private readonly idempotencyService: IdempotencyService,
  ) {}

  @Post()
  @RequirePermissions('strategy.manage')
  public async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = CreateBrandProfileRequestSchema.safeParse(body);
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
            path: '/brand-profiles',
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: policy.userId,
            method: request.method,
            route: '/brand-profiles',
          }),
          tenantId: policy.tenantId,
        },
        async (transaction) => {
          const profile = await this.brandProfileService.create(
            transaction,
            policy.tenantId,
            policy.userId,
            parsed.data,
            auditContext(request),
          );
          return {
            body: toJson({ data: profile, meta: { request_id: request.id } }),
            statusCode: HttpStatus.CREATED,
          };
        },
      );
      await reply
        .header('ETag', quoteVersion(readResponseVersion(result.response.body)))
        .status(result.response.statusCode)
        .send(result.response.body);
    } catch (error) {
      await sendBrandProfileError(reply, request.id, error);
    }
  }

  @Get()
  @RequirePermissions('strategy.read')
  public async list(
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = BrandProfileQuerySchema.safeParse(query);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const page = await this.brandProfileService.list(policy.tenantId, policy.userId, parsed.data);
      await reply.status(HttpStatus.OK).send({
        data: page.items,
        meta: { next_cursor: page.nextCursor, request_id: request.id },
      });
    } catch (error) {
      await sendBrandProfileError(reply, request.id, error);
    }
  }

  @Get(':id')
  @RequirePermissions('strategy.read')
  public async find(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = BrandProfileIdSchema.safeParse(id);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const profile = await this.brandProfileService.find(
        policy.tenantId,
        policy.userId,
        parsed.data,
      );
      await reply
        .header('ETag', quoteVersion(profile.version))
        .status(HttpStatus.OK)
        .send({ data: profile, meta: { request_id: request.id } });
    } catch (error) {
      await sendBrandProfileError(reply, request.id, error);
    }
  }

  @Post(':id/publish')
  @RequirePermissions('strategy.manage')
  public async publish(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = BrandProfileIdSchema.safeParse(id);
    const parsedBody = PublishVersionRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success) {
      await sendSchemaError(reply, request.id, [
        ...(parsedId.success ? [] : parsedId.error.issues),
        ...(parsedBody.success ? [] : parsedBody.error.issues),
      ]);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const expectedVersion = resolvePublishVersion(
        parsedBody.data.version,
        request.headers['if-match'],
      );
      const profile = await this.brandProfileService.publish(
        policy.tenantId,
        policy.userId,
        parsedId.data,
        expectedVersion,
        auditContext(request),
      );
      await reply
        .header('ETag', quoteVersion(profile.version))
        .status(HttpStatus.OK)
        .send({ data: profile, meta: { request_id: request.id } });
    } catch (error) {
      await sendBrandProfileError(reply, request.id, error);
    }
  }

  @Post(':id/retire')
  @RequirePermissions('strategy.manage')
  public async retire(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = BrandProfileIdSchema.safeParse(id);
    const parsedBody = ReasonRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success) {
      await sendSchemaError(reply, request.id, [
        ...(parsedId.success ? [] : parsedId.error.issues),
        ...(parsedBody.success ? [] : parsedBody.error.issues),
      ]);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const profile = await this.brandProfileService.retire(
        policy.tenantId,
        policy.userId,
        parsedId.data,
        parseIfMatch(request.headers['if-match']),
        parsedBody.data.reason,
        auditContext(request),
      );
      await reply
        .header('ETag', quoteVersion(profile.version))
        .status(HttpStatus.OK)
        .send({ data: profile, meta: { request_id: request.id } });
    } catch (error) {
      await sendBrandProfileError(reply, request.id, error);
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

function resolvePublishVersion(
  bodyVersion: number,
  headerValue: string | string[] | undefined,
): number {
  if (headerValue === undefined) return bodyVersion;
  const headerVersion = parseIfMatch(headerValue);
  if (headerVersion !== bodyVersion) throw new BrandProfileVersionConflictError();
  return bodyVersion;
}

function parseIfMatch(value: string | string[] | undefined): number {
  if (Array.isArray(value) || typeof value !== 'string') {
    throw new BrandProfileValidationError(
      'If-Match must contain the current brand profile version',
    );
  }
  const normalized = value.trim();
  if (normalized.startsWith('W/')) {
    throw new BrandProfileValidationError('Weak If-Match values are not supported');
  }
  const match = /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/u.exec(normalized);
  const version = Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new BrandProfileValidationError('If-Match must be a positive integer version');
  }
  return version;
}

function quoteVersion(version: number): string {
  return `"${version}"`;
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

function readResponseVersion(body: JsonValue): number {
  if (!isJsonRecord(body)) return 0;
  const data = body['data'];
  if (data === undefined || !isJsonRecord(data)) return 0;
  const version = data['version'];
  return typeof version === 'number' ? version : 0;
}

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function sendBrandProfileError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof BrandProfileNotFoundError) {
    await sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    return;
  }
  if (error instanceof BrandProfileVersionConflictError) {
    await sendError(reply, requestId, 'VERSION_CONFLICT');
    return;
  }
  if (error instanceof BrandProfileStateError || isDatabaseConstraintError(error)) {
    await sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
    return;
  }
  if (
    error instanceof BrandProfileValidationError ||
    error instanceof IdempotencyKeyValidationError
  ) {
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
  code: BrandProfileErrorCode,
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: { code, message: ERROR_DEFINITIONS[code].message, request_id: requestId },
  });
}
