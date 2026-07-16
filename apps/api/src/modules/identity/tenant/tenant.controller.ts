import { ERROR_DEFINITIONS, UpdateTenantRequestSchema } from '@geo-content-os/contracts';
import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Patch,
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
import { getPolicyContext, PolicyGuard, RequirePolicy } from '../rbac/index.js';
import {
  TenantNotFoundError,
  TenantValidationError,
  TenantVersionConflictError,
} from './tenant.errors.js';
import { TenantService } from './tenant.service.js';

type TenantErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID'
  | 'VERSION_CONFLICT';

@Controller('tenant')
@UseGuards(PolicyGuard)
export class TenantController {
  public constructor(
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(TenantService) private readonly tenants: TenantService,
  ) {}

  @Get()
  @RequirePolicy('tenant_member')
  public async get(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const policy = requireTenantPolicy(request);
    try {
      const tenant = await this.tenants.get(policy.tenantId, policy.userId);
      await reply
        .header('ETag', `"${tenant.version}"`)
        .status(HttpStatus.OK)
        .send({ data: tenant, meta: { request_id: request.id } });
    } catch (error) {
      await sendTenantError(reply, request.id, error);
    }
  }

  @Patch()
  @RequirePolicy('tenant_owner')
  public async update(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = UpdateTenantRequestSchema.safeParse(body);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const expectedVersion = parseIfMatch(request.headers['if-match']);
      const result = await this.idempotency.execute(
        {
          fingerprint: {
            body: parsed.data as JsonValue,
            method: request.method,
            path: '/tenant',
            query: { version: expectedVersion },
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: policy.userId,
            method: request.method,
            route: '/tenant',
          }),
          tenantId: policy.tenantId,
        },
        async (transaction) => {
          const tenant = await this.tenants.update(
            transaction,
            policy.tenantId,
            policy.userId,
            expectedVersion,
            parsed.data,
            { ip: request.ip, requestId: request.id },
          );
          return {
            body: JSON.parse(
              JSON.stringify({ data: tenant, meta: { request_id: request.id } }),
            ) as JsonValue,
            statusCode: HttpStatus.OK,
          };
        },
      );
      await reply
        .header('ETag', `"${readVersion(result.response.body)}"`)
        .status(result.response.statusCode)
        .send(result.response.body);
    } catch (error) {
      await sendTenantError(reply, request.id, error);
    }
  }
}

function requireTenantPolicy(request: FastifyRequest): { tenantId: string; userId: string } {
  const policy = getPolicyContext(request);
  if (!policy?.activeTenantId) throw new TenantNotFoundError();
  return { tenantId: policy.activeTenantId, userId: policy.userId };
}

function parseIfMatch(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = raw?.trim().match(/^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/u);
  const version = Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TenantValidationError('If-Match must contain a positive integer version');
  }
  return version;
}

function readVersion(value: JsonValue): number {
  if (!isJsonRecord(value)) return 0;
  const data = value['data'];
  if (!isJsonRecord(data)) return 0;
  return typeof data['version'] === 'number' ? data['version'] : 0;
}

function isJsonRecord(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function sendTenantError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof TenantNotFoundError)
    return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
  if (error instanceof TenantVersionConflictError)
    return sendError(reply, requestId, 'VERSION_CONFLICT');
  if (error instanceof TenantValidationError || error instanceof IdempotencyKeyValidationError) {
    return sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
  }
  if (error instanceof IdempotencyConflictError)
    return sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
  if (error instanceof IdempotencyProcessingError)
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
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
  code: TenantErrorCode,
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: { code, message: ERROR_DEFINITIONS[code].message, request_id: requestId },
  });
}
