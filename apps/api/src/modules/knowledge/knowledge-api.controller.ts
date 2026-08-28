import {
  ERROR_DEFINITIONS,
  FactQuerySchema,
  IngestJobIdSchema,
  IsoDateTimeSchema,
  ReasonRequestSchema,
  ReindexRequestSchema,
  SourceIdSchema,
  SourceListQuerySchema,
  SourceScopeQuerySchema,
  UpdateSourceValidityRequestSchema,
} from '@geo-content-os/contracts';
import {
  Body,
  Controller,
  Delete,
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

import { getPolicyContext, PolicyGuard, RequirePermissions } from '../identity/rbac/index.js';
import {
  KnowledgeApiNotFoundError,
  KnowledgeApiStateError,
  KnowledgeApiValidationError,
  KnowledgeApiVersionConflictError,
} from './knowledge-api.errors.js';
import { KnowledgeApiService } from './knowledge-api.service.js';

@Controller('sources')
@UseGuards(PolicyGuard)
export class KnowledgeSourceController {
  public constructor(
    @Inject(KnowledgeApiService) private readonly knowledgeApiService: KnowledgeApiService,
  ) {}

  @Get()
  @RequirePermissions('knowledge.read')
  public async list(
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = SourceListQuerySchema.safeParse(query);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requireTenantPolicy(request);
      const page = await this.knowledgeApiService.listSources(
        policy.tenantId,
        policy.userId,
        parsed.data,
      );
      await reply.status(HttpStatus.OK).send({
        data: page.items,
        meta: { next_cursor: page.nextCursor, request_id: request.id },
      });
    } catch (error) {
      await sendKnowledgeError(reply, request.id, error);
    }
  }

  @Get(':id')
  @RequirePermissions('knowledge.read')
  public async find(
    @Param('id') id: string,
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = SourceIdSchema.safeParse(id);
    const parsedQuery = SourceScopeQuerySchema.safeParse(query);
    if (!parsedId.success || !parsedQuery.success) {
      return sendSchemaError(reply, request.id, [
        ...(parsedId.success ? [] : parsedId.error.issues),
        ...(parsedQuery.success ? [] : parsedQuery.error.issues),
      ]);
    }
    try {
      const policy = requireTenantPolicy(request);
      const detail = await this.knowledgeApiService.sourceDetail(
        policy.tenantId,
        policy.userId,
        parsedId.data,
        parsedQuery.data,
      );
      await reply.status(HttpStatus.OK).send({ data: detail, meta: { request_id: request.id } });
    } catch (error) {
      await sendKnowledgeError(reply, request.id, error);
    }
  }

  @Post(':id/reindex')
  @RequirePermissions('knowledge.sources.manage')
  public async reindex(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = SourceIdSchema.safeParse(id);
    const parsedBody = ReindexRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, [
        ...(parsedId.success ? [] : parsedId.error.issues),
        ...(parsedBody.success ? [] : parsedBody.error.issues),
      ]);
    }
    try {
      const policy = requireTenantPolicy(request);
      const job = await this.knowledgeApiService.reindex(
        policy.tenantId,
        policy.userId,
        parsedId.data,
        parsedBody.data,
        auditContext(request),
      );
      await reply.status(HttpStatus.ACCEPTED).send({ data: job, meta: { request_id: request.id } });
    } catch (error) {
      await sendKnowledgeError(reply, request.id, error);
    }
  }

  @Patch(':id/validity')
  @RequirePermissions('knowledge.sources.manage')
  public async updateValidity(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = SourceIdSchema.safeParse(id);
    const parsedBody = UpdateSourceValidityRequestSchema.safeParse(body);
    const parsedRevision = parseStrongRevision(request.headers['if-match']);
    if (!parsedId.success || !parsedBody.success || !parsedRevision.success) {
      return sendSchemaError(reply, request.id, [
        ...(parsedId.success ? [] : parsedId.error.issues),
        ...(parsedBody.success ? [] : parsedBody.error.issues),
        ...(parsedRevision.success ? [] : parsedRevision.error.issues),
      ]);
    }
    try {
      const policy = requireTenantPolicy(request);
      const source = await this.knowledgeApiService.updateSourceValidity(
        policy.tenantId,
        policy.userId,
        parsedId.data,
        parsedRevision.data,
        parsedBody.data,
        auditContext(request),
      );
      await reply.status(HttpStatus.OK).send({ data: source, meta: { request_id: request.id } });
    } catch (error) {
      await sendKnowledgeError(reply, request.id, error);
    }
  }

  @Delete(':id')
  @RequirePermissions('knowledge.sources.manage')
  public async remove(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = SourceIdSchema.safeParse(id);
    const parsedBody = ReasonRequestSchema.safeParse(body);
    const parsedRevision = parseStrongRevision(request.headers['if-match']);
    if (!parsedId.success || !parsedBody.success || !parsedRevision.success) {
      return sendSchemaError(reply, request.id, [
        ...(parsedId.success ? [] : parsedId.error.issues),
        ...(parsedBody.success ? [] : parsedBody.error.issues),
        ...(parsedRevision.success ? [] : parsedRevision.error.issues),
      ]);
    }
    try {
      const policy = requireTenantPolicy(request);
      await this.knowledgeApiService.deleteSource(
        policy.tenantId,
        policy.userId,
        parsedId.data,
        parsedRevision.data,
        parsedBody.data,
        auditContext(request),
      );
      await reply.status(HttpStatus.NO_CONTENT).send();
    } catch (error) {
      await sendKnowledgeError(reply, request.id, error);
    }
  }
}

function parseStrongRevision(value: string | string[] | undefined) {
  if (Array.isArray(value) || typeof value !== 'string' || value.startsWith('W/')) {
    return IsoDateTimeSchema.safeParse(undefined);
  }
  const normalized = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return IsoDateTimeSchema.safeParse(normalized);
}

@Controller('ingest-jobs')
@UseGuards(PolicyGuard)
export class IngestJobController {
  public constructor(
    @Inject(KnowledgeApiService) private readonly knowledgeApiService: KnowledgeApiService,
  ) {}

  @Get(':id')
  @RequirePermissions('knowledge.read')
  public async find(
    @Param('id') id: string,
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedId = IngestJobIdSchema.safeParse(id);
    const parsedQuery = SourceScopeQuerySchema.safeParse(query);
    if (!parsedId.success || !parsedQuery.success) {
      return sendSchemaError(reply, request.id, [
        ...(parsedId.success ? [] : parsedId.error.issues),
        ...(parsedQuery.success ? [] : parsedQuery.error.issues),
      ]);
    }
    try {
      const policy = requireTenantPolicy(request);
      const job = await this.knowledgeApiService.getIngestJob(
        policy.tenantId,
        policy.userId,
        parsedId.data,
        parsedQuery.data,
      );
      await reply.status(HttpStatus.OK).send({ data: job, meta: { request_id: request.id } });
    } catch (error) {
      await sendKnowledgeError(reply, request.id, error);
    }
  }
}

@Controller('facts')
@UseGuards(PolicyGuard)
export class KnowledgeFactController {
  public constructor(
    @Inject(KnowledgeApiService) private readonly knowledgeApiService: KnowledgeApiService,
  ) {}

  @Get()
  @RequirePermissions('knowledge.read')
  public async list(
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = FactQuerySchema.safeParse(query);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requireTenantPolicy(request);
      const page = await this.knowledgeApiService.listFacts(
        policy.tenantId,
        policy.userId,
        parsed.data,
      );
      await reply.status(HttpStatus.OK).send({
        data: page.items,
        meta: { next_cursor: page.nextCursor, request_id: request.id },
      });
    } catch (error) {
      await sendKnowledgeError(reply, request.id, error);
    }
  }
}

function requireTenantPolicy(request: FastifyRequest): { tenantId: string; userId: string } {
  const policy = getPolicyContext(request);
  if (!policy?.activeTenantId)
    throw new Error('PolicyGuard did not attach an active tenant PolicyContext');
  return { tenantId: policy.activeTenantId, userId: policy.userId };
}

function auditContext(request: FastifyRequest): { ip?: string; requestId: string } {
  return { ...(request.ip ? { ip: request.ip } : {}), requestId: request.id };
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

async function sendKnowledgeError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof KnowledgeApiNotFoundError)
    return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
  if (error instanceof KnowledgeApiVersionConflictError)
    return sendError(reply, requestId, 'VERSION_CONFLICT');
  if (error instanceof KnowledgeApiStateError)
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
  if (error instanceof KnowledgeApiValidationError)
    return sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
  throw error;
}

async function sendError(
  reply: FastifyReply,
  requestId: string,
  code:
    | 'RESOURCE_NOT_FOUND'
    | 'SCHEMA_VALIDATION_FAILED'
    | 'STATE_TRANSITION_INVALID'
    | 'VERSION_CONFLICT',
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: { code, message: ERROR_DEFINITIONS[code].message, request_id: requestId },
  });
}
