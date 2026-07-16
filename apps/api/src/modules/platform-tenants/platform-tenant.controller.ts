import {
  CreateTenantRequestSchema,
  ERROR_DEFINITIONS,
  PlatformTenantIdSchema,
  SuspendTenantRequestSchema,
  TenantListQuerySchema,
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
} from '../../common/idempotency/index.js';
import { getPolicyContext, PolicyGuard, RequirePolicy } from '../identity/rbac/index.js';
import {
  PlatformTenantConflictError,
  PlatformTenantNotFoundError,
  PlatformTenantStateError,
  PlatformTenantVersionError,
} from './platform-tenant.errors.js';
import { PlatformTenantService } from './platform-tenant.service.js';

type PlatformTenantErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID'
  | 'VERSION_CONFLICT';

@Controller('platform/tenants')
@UseGuards(PolicyGuard)
@RequirePolicy('platform_admin')
export class PlatformTenantController {
  public constructor(
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(PlatformTenantService) private readonly tenants: PlatformTenantService,
  ) {}

  @Get()
  public async list(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const query = TenantListQuerySchema.safeParse(raw);
    if (!query.success) return sendSchemaError(reply, request.id, query.error.issues);
    try {
      const page = await this.tenants.list(query.data);
      await reply.send({
        data: { items: page.items, next_cursor: page.nextCursor },
        meta: { request_id: request.id },
      });
    } catch (error) {
      await sendPlatformTenantError(reply, request.id, error);
    }
  }

  @Post()
  public async create(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const body = CreateTenantRequestSchema.safeParse(raw);
    if (!body.success) return sendSchemaError(reply, request.id, body.error.issues);
    const actorId = requireActor(request);
    try {
      const result = await this.idempotency.execute(
        {
          fingerprint: {
            body: body.data as JsonValue,
            method: request.method,
            path: '/platform/tenants',
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId,
            method: request.method,
            route: '/platform/tenants',
          }),
          tenantId: null,
        },
        async (transaction) => {
          const tenant = await this.tenants.create(
            transaction,
            actorId,
            body.data,
            auditContext(request),
          );
          return {
            body: toJson({ data: tenant, meta: { request_id: request.id } }),
            statusCode: HttpStatus.CREATED,
          };
        },
      );
      await reply
        .header('etag', `"${readVersion(result.response.body)}"`)
        .status(result.response.statusCode)
        .send(result.response.body);
    } catch (error) {
      await sendPlatformTenantError(reply, request.id, error);
    }
  }

  @Post(':id/suspend')
  public async suspend(
    @Param('id') rawId: string,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const id = PlatformTenantIdSchema.safeParse(rawId);
    const body = SuspendTenantRequestSchema.safeParse(raw);
    const version = parseIfMatch(request.headers['if-match']);
    if (!id.success || !body.success || version === null) {
      return sendSchemaError(reply, request.id, [
        ...(id.success ? [] : id.error.issues),
        ...(body.success ? [] : body.error.issues),
        ...(version === null ? [headerIssue()] : []),
      ]);
    }
    try {
      const tenant = await this.tenants.suspend(
        requireActor(request),
        id.data,
        version,
        body.data.reason,
        auditContext(request),
      );
      await sendTenant(reply, request.id, tenant);
    } catch (error) {
      await sendPlatformTenantError(reply, request.id, error);
    }
  }

  @Post(':id/restore')
  public async restore(
    @Param('id') rawId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const id = PlatformTenantIdSchema.safeParse(rawId);
    const version = parseIfMatch(request.headers['if-match']);
    if (!id.success || version === null) {
      return sendSchemaError(reply, request.id, [
        ...(id.success ? [] : id.error.issues),
        ...(version === null ? [headerIssue()] : []),
      ]);
    }
    try {
      const tenant = await this.tenants.restore(
        requireActor(request),
        id.data,
        version,
        auditContext(request),
      );
      await sendTenant(reply, request.id, tenant);
    } catch (error) {
      await sendPlatformTenantError(reply, request.id, error);
    }
  }
}

async function sendTenant(
  reply: FastifyReply,
  requestId: string,
  tenant: { readonly version: number },
): Promise<void> {
  await reply
    .header('etag', `"${tenant.version}"`)
    .status(HttpStatus.OK)
    .send({ data: tenant, meta: { request_id: requestId } });
}

async function sendPlatformTenantError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof PlatformTenantNotFoundError) {
    return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
  }
  if (error instanceof PlatformTenantConflictError) {
    return sendError(reply, requestId, 'VERSION_CONFLICT');
  }
  if (error instanceof PlatformTenantStateError || error instanceof IdempotencyProcessingError) {
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
  }
  if (error instanceof PlatformTenantVersionError) {
    return sendError(reply, requestId, 'VERSION_CONFLICT');
  }
  if (error instanceof IdempotencyConflictError) {
    return sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
  }
  if (error instanceof IdempotencyKeyValidationError) {
    return sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
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
  code: PlatformTenantErrorCode,
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: { code, message: ERROR_DEFINITIONS[code].message, request_id: requestId },
  });
}

function requireActor(request: FastifyRequest): string {
  const context = getPolicyContext(request);
  if (!context) throw new Error('PolicyGuard did not attach a PolicyContext');
  return context.userId;
}

function auditContext(request: FastifyRequest) {
  return { ip: request.ip, requestId: request.id };
}

function parseIfMatch(value: string | string[] | undefined): number | null {
  if (Array.isArray(value) || !value) return null;
  const match = /^"?([1-9][0-9]*)"?$/u.exec(value.trim());
  if (!match?.[1]) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : null;
}

function headerIssue() {
  return { code: 'custom', path: ['headers', 'if-match'] };
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function readVersion(value: JsonValue): number {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('data' in value)) {
    throw new Error('Cached tenant response is missing a version');
  }
  const data = value['data'];
  if (!isJsonObject(data)) {
    throw new Error('Cached tenant response is missing a version');
  }
  const version = data['version'];
  if (typeof version !== 'number') throw new Error('Cached tenant response is missing a version');
  return version;
}

function isJsonObject(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
