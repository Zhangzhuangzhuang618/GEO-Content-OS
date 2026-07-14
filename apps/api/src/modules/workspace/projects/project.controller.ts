import {
  CreateProjectRequestSchema,
  ERROR_DEFINITIONS,
  ProjectIdSchema,
  ProjectListQuerySchema,
  UpdateProjectRequestSchema,
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
  ProjectNotFoundError,
  ProjectStateError,
  ProjectValidationError,
  ProjectVersionConflictError,
} from './project.errors.js';
import { ProjectService } from './project.service.js';

type ProjectErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID'
  | 'VERSION_CONFLICT';

@Controller('projects')
@UseGuards(PolicyGuard)
export class ProjectController {
  public constructor(
    @Inject(IdempotencyService) private readonly idempotencyService: IdempotencyService,
    @Inject(ProjectService) private readonly projectService: ProjectService,
  ) {}

  @Post()
  @RequirePermissions('strategy.manage')
  public async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = CreateProjectRequestSchema.safeParse(body);
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
            path: '/projects',
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: policy.userId,
            method: request.method,
            route: '/projects',
          }),
          tenantId: policy.tenantId,
        },
        async (transaction) => {
          const project = await this.projectService.create(
            transaction,
            policy.tenantId,
            policy.userId,
            parsed.data,
            auditContext(request),
          );
          return {
            body: toJson({ data: project, meta: { request_id: request.id } }),
            statusCode: HttpStatus.CREATED,
          };
        },
      );
      await reply
        .header('ETag', quoteVersion(readResponseVersion(result.response.body)))
        .status(result.response.statusCode)
        .send(result.response.body);
    } catch (error) {
      await sendProjectError(reply, request.id, error);
    }
  }

  @Get()
  @RequirePermissions('strategy.read')
  public async list(
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = ProjectListQuerySchema.safeParse(query);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const page = await this.projectService.list(policy.tenantId, policy.userId, parsed.data);
      await reply.status(HttpStatus.OK).send({
        data: page.items,
        meta: { next_cursor: page.nextCursor, request_id: request.id },
      });
    } catch (error) {
      await sendProjectError(reply, request.id, error);
    }
  }

  @Get(':id')
  @RequirePermissions('strategy.read')
  public async find(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = ProjectIdSchema.safeParse(id);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const project = await this.projectService.find(policy.tenantId, policy.userId, parsed.data);
      await reply
        .header('ETag', quoteVersion(project.version))
        .status(HttpStatus.OK)
        .send({ data: project, meta: { request_id: request.id } });
    } catch (error) {
      await sendProjectError(reply, request.id, error);
    }
  }

  @Patch(':id')
  @RequirePermissions('strategy.manage')
  public async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = ProjectIdSchema.safeParse(id);
    const parsedBody = UpdateProjectRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success) {
      await sendSchemaError(reply, request.id, [
        ...(parsedId.success ? [] : parsedId.error.issues),
        ...(parsedBody.success ? [] : parsedBody.error.issues),
      ]);
      return;
    }
    const policy = requireTenantPolicy(request);
    try {
      const expectedVersion = parseIfMatch(request.headers['if-match']);
      const route = `/projects/${parsedId.data}`;
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
          const project = await this.projectService.update(
            transaction,
            policy.tenantId,
            policy.userId,
            parsedId.data,
            expectedVersion,
            parsedBody.data,
            auditContext(request),
          );
          return {
            body: toJson({ data: project, meta: { request_id: request.id } }),
            statusCode: HttpStatus.OK,
          };
        },
      );
      await reply
        .header('ETag', quoteVersion(readResponseVersion(result.response.body)))
        .status(result.response.statusCode)
        .send(result.response.body);
    } catch (error) {
      await sendProjectError(reply, request.id, error);
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
  return {
    tenantId: policy.activeTenantId,
    userId: policy.userId,
  };
}

function parseIfMatch(value: string | string[] | undefined): number {
  if (Array.isArray(value) || typeof value !== 'string') {
    throw new ProjectValidationError('If-Match must contain the current project version');
  }
  const normalized = value.trim();
  if (normalized.startsWith('W/')) {
    throw new ProjectValidationError('Weak If-Match values are not supported');
  }
  const match = /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/u.exec(normalized);
  const version = Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new ProjectValidationError('If-Match must be a positive integer version');
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

async function sendProjectError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof ProjectNotFoundError) {
    await sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    return;
  }
  if (error instanceof ProjectVersionConflictError) {
    await sendError(reply, requestId, 'VERSION_CONFLICT');
    return;
  }
  if (error instanceof ProjectStateError || isDatabaseConstraintError(error)) {
    await sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
    return;
  }
  if (error instanceof ProjectValidationError || error instanceof IdempotencyKeyValidationError) {
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
  code: ProjectErrorCode,
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: { code, message: ERROR_DEFINITIONS[code].message, request_id: requestId },
  });
}
