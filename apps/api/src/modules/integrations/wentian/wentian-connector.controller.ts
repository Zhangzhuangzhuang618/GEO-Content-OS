import {
  ERROR_DEFINITIONS,
  WentianBindingParamsSchema,
  WentianBindingRefreshRequestSchema,
  WentianBindingRequestSchema,
  WentianQuerySetSyncRequestSchema,
  WentianSsoTicketRequestSchema,
  WentianStatusQuerySchema,
  type ErrorCode,
} from '@geo-content-os/contracts';
import {
  Body,
  Controller,
  Delete,
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
  WentianBindingConflictError,
  WentianBindingNotFoundError,
  WentianConnectorNotConfiguredError,
  WentianConnectorPermissionError,
  WentianConnectorService,
  WentianConnectorStateError,
  WentianQuerySetValidationError,
  isWentianRemoteConflict,
  type WentianConnectorScope,
} from './wentian-connector.service.js';
import {
  WentianConnectorNotConfiguredError as WentianClientNotConfiguredError,
  WentianConnectorResponseError,
  WentianConnectorUnavailableError,
  WentianRemoteRequestError,
} from './wentian-signed-client.js';

@Controller('integrations/wentian')
@UseGuards(PolicyGuard)
export class WentianConnectorController {
  public constructor(
    @Inject(WentianConnectorService) private readonly service: WentianConnectorService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  @Get('status')
  @RequirePermissions('tenant.profile.read')
  public async status(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = WentianStatusQuerySchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const result = await this.service.status(requireScope(request), {
        projectId: parsed.data.project_id,
        workspaceId: parsed.data.workspace_id,
      });
      await reply.status(HttpStatus.OK).send(apiResponse(result, request.id));
    } catch (error) {
      await sendWentianError(reply, request.id, error);
    }
  }

  @Post('bindings')
  @RequirePermissions('tenant.members.manage')
  public async requestBinding(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = WentianBindingRequestSchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      const key = connectorIdempotencyKey(request);
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, '/integrations/wentian/bindings', parsed.data, key),
        async (transaction) => ({
          body: apiResponse(
            await this.service.requestBinding(
              transaction,
              scope,
              { projectId: parsed.data.project_id, workspaceId: parsed.data.workspace_id },
              key,
            ),
            request.id,
          ),
          statusCode: HttpStatus.CREATED,
        }),
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendWentianError(reply, request.id, error);
    }
  }

  @Post('bindings/:id/refresh')
  @RequirePermissions('tenant.members.manage')
  public async refreshBinding(
    @Param() rawParams: unknown,
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const params = WentianBindingParamsSchema.safeParse(rawParams);
    const body = WentianBindingRefreshRequestSchema.safeParse(rawBody);
    if (!params.success || !body.success) {
      return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    }
    const route = `/integrations/wentian/bindings/${params.data.id}/refresh`;
    try {
      const scope = requireScope(request);
      const key = connectorIdempotencyKey(request);
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, route, body.data, key),
        async (transaction) => ({
          body: apiResponse(
            await this.service.refreshBinding(
              transaction,
              scope,
              params.data.id,
              { projectId: body.data.project_id, workspaceId: body.data.workspace_id },
              key,
            ),
            request.id,
          ),
          statusCode: HttpStatus.OK,
        }),
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendWentianError(reply, request.id, error);
    }
  }

  @Delete('bindings/:id')
  @RequirePermissions('tenant.members.manage')
  public async disconnectBinding(
    @Param() rawParams: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const params = WentianBindingParamsSchema.safeParse(rawParams);
    if (!params.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    const route = `/integrations/wentian/bindings/${params.data.id}`;
    try {
      const scope = requireScope(request);
      const key = connectorIdempotencyKey(request);
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, route, null, key),
        async (transaction) => ({
          body: apiResponse(
            await this.service.disconnectBinding(transaction, scope, params.data.id, key),
            request.id,
          ),
          statusCode: HttpStatus.OK,
        }),
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendWentianError(reply, request.id, error);
    }
  }

  @Post('sso-tickets')
  @RequirePermissions('tenant.profile.read')
  public async issueSsoTicket(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = WentianSsoTicketRequestSchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      const key = connectorIdempotencyKey(request);
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, '/integrations/wentian/sso-tickets', parsed.data, key),
        async (transaction) => ({
          body: apiResponse(
            await this.service.issueSsoTicket(
              transaction,
              scope,
              { projectId: parsed.data.project_id, workspaceId: parsed.data.workspace_id },
              key,
            ),
            request.id,
          ),
          statusCode: HttpStatus.CREATED,
        }),
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendWentianError(reply, request.id, error);
    }
  }

  @Post('query-set-syncs')
  @RequirePermissions('tenant.members.manage')
  public async syncQuerySet(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = WentianQuerySetSyncRequestSchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      const key = connectorIdempotencyKey(request);
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, '/integrations/wentian/query-set-syncs', parsed.data, key),
        async (transaction) => ({
          body: apiResponse(
            await this.service.syncQuerySet(
              transaction,
              scope,
              {
                projectId: parsed.data.project_id,
                querySetId: parsed.data.query_set_id,
                workspaceId: parsed.data.workspace_id,
              },
              key,
            ),
            request.id,
          ),
          statusCode: HttpStatus.CREATED,
        }),
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendWentianError(reply, request.id, error);
    }
  }
}

function requireScope(request: FastifyRequest): WentianConnectorScope {
  const policy = getPolicyContext(request);
  if (!policy?.activeTenantId) {
    throw new Error('PolicyGuard did not attach an active tenant PolicyContext');
  }
  return { requestId: request.id, tenantId: policy.activeTenantId, userId: policy.userId };
}

function connectorIdempotencyKey(request: FastifyRequest): string {
  const key = parseIdempotencyKey(request.headers['idempotency-key']);
  if (key.length < 8 || key.length > 128) {
    throw new IdempotencyKeyValidationError('Idempotency-Key must contain 8 to 128 characters');
  }
  return key;
}

function idempotencyInput(
  request: FastifyRequest,
  scope: WentianConnectorScope,
  route: string,
  body: JsonValue,
  idempotencyKey: string,
) {
  return {
    fingerprint: { body, method: request.method, path: route },
    idempotencyKey,
    scopeKey: buildIdempotencyScope({ actorId: scope.userId, method: request.method, route }),
    tenantId: scope.tenantId,
  };
}

function apiResponse<T>(data: T, requestId: string): JsonValue {
  return JSON.parse(JSON.stringify({ data, meta: { request_id: requestId } })) as JsonValue;
}

async function sendWentianError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (
    error instanceof WentianConnectorNotConfiguredError ||
    error instanceof WentianClientNotConfiguredError
  ) {
    return sendError(reply, requestId, 'WENTIAN_CONNECTOR_NOT_CONFIGURED');
  }
  if (error instanceof WentianConnectorPermissionError) {
    return sendError(reply, requestId, 'PERMISSION_DENIED');
  }
  if (error instanceof WentianBindingNotFoundError) {
    return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
  }
  if (
    error instanceof WentianBindingConflictError ||
    error instanceof IdempotencyConflictError ||
    error instanceof IdempotencyProcessingError ||
    isWentianRemoteConflict(error)
  ) {
    return sendError(reply, requestId, 'WENTIAN_BINDING_CONFLICT');
  }
  if (
    error instanceof WentianQuerySetValidationError ||
    error instanceof IdempotencyKeyValidationError
  ) {
    return sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
  }
  if (error instanceof WentianRemoteRequestError) {
    if (error.status === 404 || error.code === 'GEO_BINDING_NOT_FOUND') {
      return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    }
    if (error.code === 'GEO_ROLE_NOT_MAPPED') {
      return sendError(reply, requestId, 'PERMISSION_DENIED');
    }
    if (error.code === 'GEO_QUERY_SET_INVALID') {
      return sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
    }
    return sendError(reply, requestId, 'WENTIAN_CONNECTOR_UNAVAILABLE');
  }
  if (
    error instanceof WentianConnectorUnavailableError ||
    error instanceof WentianConnectorResponseError
  ) {
    return sendError(reply, requestId, 'WENTIAN_CONNECTOR_UNAVAILABLE');
  }
  if (error instanceof WentianConnectorStateError) {
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
  }
  return sendError(reply, requestId, 'WENTIAN_CONNECTOR_UNAVAILABLE');
}

async function sendError(reply: FastifyReply, requestId: string, code: ErrorCode): Promise<void> {
  const definition = ERROR_DEFINITIONS[code];
  await reply.status(definition.httpStatus).send({
    error: { code, message: definition.message, request_id: requestId },
  });
}
