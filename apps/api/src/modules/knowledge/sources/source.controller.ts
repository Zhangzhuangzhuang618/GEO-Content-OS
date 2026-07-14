import { ERROR_DEFINITIONS } from '@geo-content-os/contracts';
import { Controller, HttpStatus, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
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
  SourceDuplicateError,
  SourceNotFoundError,
  SourceStorageError,
  SourceUploadValidationError,
} from './source.errors.js';
import { readSourceUploadConfiguration } from './source.config.js';
import { SourceService } from './source.service.js';
import { parseSourceUpload } from './source-upload.parser.js';

type SourceErrorCode =
  | 'ADAPTER_CAPABILITY_UNAVAILABLE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID';

@Controller('sources')
@UseGuards(PolicyGuard)
export class SourceController {
  private readonly configuration = readSourceUploadConfiguration();

  public constructor(
    @Inject(IdempotencyService) private readonly idempotencyService: IdempotencyService,
    @Inject(SourceService) private readonly sourceService: SourceService,
  ) {}

  @Post()
  @RequirePermissions('knowledge.sources.manage')
  public async upload(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    try {
      const input = await parseSourceUpload(request, this.configuration.maxFileBytes);
      const policy = getPolicyContext(request);
      if (!policy?.activeTenantId) {
        throw new Error('PolicyGuard did not attach an active tenant PolicyContext');
      }
      const tenantId = policy.activeTenantId;
      const result = await this.idempotencyService.execute(
        {
          fingerprint: {
            body: {
              content_hash: input.contentHash,
              effective_from: input.effectiveFrom,
              effective_to: input.effectiveTo,
              filename: input.filename,
              language: input.language,
              mime_type: input.mimeType,
              project_id: input.projectId,
              size_bytes: input.body.byteLength,
              title: input.title,
              trust_level: input.trustLevel,
              workspace_id: input.workspaceId,
            },
            method: request.method,
            path: '/sources',
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: policy.userId,
            method: request.method,
            route: '/sources',
          }),
          tenantId,
        },
        async (transaction) => {
          const uploaded = await this.sourceService.upload(
            transaction,
            tenantId,
            policy.userId,
            input,
            { ...(request.ip ? { ip: request.ip } : {}), requestId: request.id },
          );
          return {
            body: toJson({ data: uploaded, meta: { request_id: request.id } }),
            statusCode: HttpStatus.CREATED,
          };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendSourceError(reply, request.id, error);
    }
  }
}

async function sendSourceError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof SourceNotFoundError) {
    await sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    return;
  }
  if (error instanceof SourceDuplicateError || error instanceof IdempotencyProcessingError) {
    await sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
    return;
  }
  if (
    error instanceof SourceUploadValidationError ||
    error instanceof IdempotencyKeyValidationError
  ) {
    await sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
    return;
  }
  if (error instanceof IdempotencyConflictError) {
    await sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
    return;
  }
  if (error instanceof SourceStorageError) {
    await sendError(reply, requestId, 'ADAPTER_CAPABILITY_UNAVAILABLE');
    return;
  }
  throw error;
}

async function sendError(
  reply: FastifyReply,
  requestId: string,
  code: SourceErrorCode,
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: { code, message: ERROR_DEFINITIONS[code].message, request_id: requestId },
  });
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
