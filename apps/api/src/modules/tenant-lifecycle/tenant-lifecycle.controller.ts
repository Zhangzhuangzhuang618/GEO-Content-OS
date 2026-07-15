import {
  ERROR_DEFINITIONS,
  TenantExportParamsSchema,
  TenantExportRequestSchema,
} from '@geo-content-os/contracts';
import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  Post,
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
import { getPolicyContext, PolicyGuard, RequirePermissions } from '../identity/rbac/index.js';
import {
  TenantLifecycleAccessError,
  TenantLifecycleStateError,
  TenantLifecycleValidationError,
} from './tenant-lifecycle.errors.js';
import { TenantLifecycleService } from './tenant-lifecycle.service.js';
import type { TenantExportJobView } from './tenant-lifecycle.types.js';

type TenantLifecycleErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'PERMISSION_DENIED'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID';

@Controller('tenant-exports')
@UseGuards(PolicyGuard)
export class TenantLifecycleController {
  public constructor(
    @Inject(TenantLifecycleService) private readonly lifecycle: TenantLifecycleService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @RequirePermissions('audit.export')
  public async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = TenantExportRequestSchema.safeParse(body);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const policy = requirePolicy(request);
      const result = await this.idempotency.execute(
        {
          fingerprint: { body: parsed.data, method: request.method, path: '/tenant-exports' },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: policy.userId,
            method: request.method,
            route: '/tenant-exports',
          }),
          tenantId: policy.tenantId,
        },
        async (transaction) => {
          const job = await this.lifecycle.requestExport(transaction, {
            requestId: request.id,
            tenantId: policy.tenantId,
            userId: policy.userId,
          });
          return {
            body: response(job, request.id),
            statusCode: HttpStatus.CREATED,
          };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendLifecycleError(reply, request.id, error);
    }
  }

  @Get(':id')
  @RequirePermissions('audit.export')
  public async get(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = TenantExportParamsSchema.safeParse(params);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const policy = requirePolicy(request);
      const job = await this.lifecycle.getExport(
        { requestId: request.id, tenantId: policy.tenantId, userId: policy.userId },
        parsed.data.id,
      );
      await reply.status(HttpStatus.OK).send(response(job, request.id));
    } catch (error) {
      await sendLifecycleError(reply, request.id, error);
    }
  }
}

function requirePolicy(request: FastifyRequest): {
  readonly tenantId: string;
  readonly userId: string;
} {
  const policy = getPolicyContext(request);
  if (!policy?.activeTenantId) throw new TenantLifecycleAccessError();
  return { tenantId: policy.activeTenantId, userId: policy.userId };
}

function response(job: TenantExportJobView, requestId: string): JsonValue {
  return JSON.parse(
    JSON.stringify({
      data: {
        created_at: job.createdAt,
        error_json: job.error,
        expires_at: job.expiresAt,
        id: job.id,
        manifest_hash: job.manifestHash,
        object_uri: job.objectUri,
        requested_by: job.requestedBy,
        status: job.status,
        tenant_id: job.tenantId,
        updated_at: job.updatedAt,
      },
      meta: { request_id: requestId },
    }),
  ) as JsonValue;
}

async function sendLifecycleError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof TenantLifecycleAccessError) {
    return sendError(reply, requestId, 'PERMISSION_DENIED');
  }
  if (error instanceof TenantLifecycleStateError) {
    return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
  }
  if (
    error instanceof TenantLifecycleValidationError ||
    error instanceof IdempotencyKeyValidationError
  ) {
    return sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
  }
  if (error instanceof IdempotencyConflictError) {
    return sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
  }
  if (error instanceof IdempotencyProcessingError) {
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
  }
  throw error;
}

async function sendError(
  reply: FastifyReply,
  requestId: string,
  code: TenantLifecycleErrorCode,
): Promise<void> {
  const definition = ERROR_DEFINITIONS[code];
  await reply.status(definition.httpStatus).send({
    error: { code, message: definition.message, request_id: requestId },
  });
}
