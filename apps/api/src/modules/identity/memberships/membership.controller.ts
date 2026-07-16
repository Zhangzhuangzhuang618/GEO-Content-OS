import {
  ERROR_DEFINITIONS,
  MembershipIdSchema,
  MembershipListQuerySchema,
  ReasonRequestSchema,
  UpdateMembershipRequestSchema,
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
import { IdentityAuthDatabase } from '../auth/auth.database.js';
import { getPolicyContext, PolicyGuard, RequirePermissions } from '../rbac/index.js';
import {
  MembershipNotFoundError,
  MembershipPermissionError,
  MembershipStateError,
  MembershipValidationError,
  MembershipVersionConflictError,
} from './membership.errors.js';
import { MembershipService } from './membership.service.js';

type MembershipErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'PERMISSION_DENIED'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID'
  | 'VERSION_CONFLICT';

@Controller('memberships')
@UseGuards(PolicyGuard)
export class MembershipController {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
  ) {}

  @Get()
  @RequirePermissions('tenant.members.read')
  public async list(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = MembershipListQuerySchema.safeParse(raw);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    const scope = requireScope(request);
    try {
      const page = await this.memberships.list(scope.tenantId, scope.userId, parsed.data);
      await reply.status(HttpStatus.OK).send({
        data: { items: page.items, next_cursor: page.nextCursor },
        meta: { request_id: request.id },
      });
    } catch (error) {
      await sendMembershipError(reply, request.id, error);
    }
  }

  @Patch(':id')
  @RequirePermissions('tenant.members.manage')
  public async update(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const id = MembershipIdSchema.safeParse(rawId);
    const body = UpdateMembershipRequestSchema.safeParse(rawBody);
    if (!id.success || !body.success) {
      return sendSchemaError(reply, request.id, [
        ...(id.success ? [] : id.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
    }
    const scope = requireScope(request);
    try {
      const expectedVersion = parseIfMatch(request.headers['if-match']);
      const route = `/memberships/${id.data}`;
      const result = await this.idempotency.execute(
        {
          fingerprint: {
            body: body.data as JsonValue,
            method: request.method,
            path: route,
            query: { version: expectedVersion },
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: scope.userId,
            method: request.method,
            route,
          }),
          tenantId: scope.tenantId,
        },
        async (transaction) => {
          const membership = await this.memberships.update(
            transaction,
            scope.tenantId,
            scope.userId,
            id.data,
            expectedVersion,
            body.data,
            auditContext(request),
          );
          return {
            body: toJson({ data: membership, meta: { request_id: request.id } }),
            statusCode: HttpStatus.OK,
          };
        },
      );
      await reply
        .header('ETag', quoteVersion(readResponseVersion(result.response.body)))
        .status(result.response.statusCode)
        .send(result.response.body);
    } catch (error) {
      await sendMembershipError(reply, request.id, error);
    }
  }

  @Post(':id/disable')
  @RequirePermissions('tenant.members.manage')
  public async disable(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const id = MembershipIdSchema.safeParse(rawId);
    const body = ReasonRequestSchema.safeParse(rawBody);
    if (!id.success || !body.success) {
      return sendSchemaError(reply, request.id, [
        ...(id.success ? [] : id.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
    }
    const scope = requireScope(request);
    try {
      const membership = await this.database.client.begin((transaction) =>
        this.memberships.disable(
          transaction,
          scope.tenantId,
          scope.userId,
          id.data,
          parseIfMatch(request.headers['if-match']),
          body.data.reason,
          auditContext(request),
        ),
      );
      await reply
        .header('ETag', quoteVersion(membership.version))
        .status(HttpStatus.OK)
        .send({ data: membership, meta: { request_id: request.id } });
    } catch (error) {
      await sendMembershipError(reply, request.id, error);
    }
  }

  @Post(':id/restore')
  @RequirePermissions('tenant.members.manage')
  public async restore(
    @Param('id') rawId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const id = MembershipIdSchema.safeParse(rawId);
    if (!id.success) return sendSchemaError(reply, request.id, id.error.issues);
    const scope = requireScope(request);
    try {
      const membership = await this.database.client.begin((transaction) =>
        this.memberships.restore(
          transaction,
          scope.tenantId,
          scope.userId,
          id.data,
          parseIfMatch(request.headers['if-match']),
          auditContext(request),
        ),
      );
      await reply
        .header('ETag', quoteVersion(membership.version))
        .status(HttpStatus.OK)
        .send({ data: membership, meta: { request_id: request.id } });
    } catch (error) {
      await sendMembershipError(reply, request.id, error);
    }
  }
}

function requireScope(request: FastifyRequest) {
  const policy = getPolicyContext(request);
  if (!policy?.activeTenantId) throw new MembershipPermissionError();
  return { tenantId: policy.activeTenantId, userId: policy.userId };
}

function parseIfMatch(value: string | string[] | undefined): number {
  if (Array.isArray(value) || typeof value !== 'string') throw new MembershipValidationError();
  const normalized = value.trim();
  if (normalized.startsWith('W/')) throw new MembershipValidationError();
  const match = /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/u.exec(normalized);
  const version = Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(version) || version <= 0) throw new MembershipValidationError();
  return version;
}

function auditContext(request: FastifyRequest) {
  return { ...(request.ip ? { ip: request.ip } : {}), requestId: request.id };
}

function quoteVersion(version: number) {
  return `"${version}"`;
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function readResponseVersion(body: JsonValue): number {
  if (!isJsonRecord(body)) return 0;
  const data = body['data'];
  if (!isJsonRecord(data)) return 0;
  return typeof data['version'] === 'number' ? data['version'] : 0;
}

function isJsonRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function sendMembershipError(reply: FastifyReply, requestId: string, error: unknown) {
  if (error instanceof MembershipNotFoundError)
    return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
  if (error instanceof MembershipPermissionError)
    return sendError(reply, requestId, 'PERMISSION_DENIED');
  if (error instanceof MembershipVersionConflictError)
    return sendError(reply, requestId, 'VERSION_CONFLICT');
  if (
    error instanceof MembershipStateError ||
    isConstraint(error, 'memberships_last_active_owner_check')
  )
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
  if (error instanceof MembershipValidationError || error instanceof IdempotencyKeyValidationError)
    return sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
  if (error instanceof IdempotencyConflictError)
    return sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
  if (error instanceof IdempotencyProcessingError)
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
  throw error;
}

function isConstraint(error: unknown, name: string): boolean {
  if (!error || typeof error !== 'object') return false;
  return (
    Reflect.get(error, 'constraint_name') === name ||
    String(Reflect.get(error, 'message')).includes(name)
  );
}

async function sendSchemaError(
  reply: FastifyReply,
  requestId: string,
  issues: readonly { readonly code: string; readonly path: PropertyKey[] }[],
) {
  await reply.status(HttpStatus.UNPROCESSABLE_ENTITY).send({
    error: {
      code: 'SCHEMA_VALIDATION_FAILED',
      details: { issues: issues.map((issue) => ({ code: issue.code, path: issue.path })) },
      message: ERROR_DEFINITIONS.SCHEMA_VALIDATION_FAILED.message,
      request_id: requestId,
    },
  });
}

async function sendError(reply: FastifyReply, requestId: string, code: MembershipErrorCode) {
  const definition = ERROR_DEFINITIONS[code];
  await reply.status(definition.httpStatus).send({
    error: { code, message: definition.message, request_id: requestId },
  });
}
