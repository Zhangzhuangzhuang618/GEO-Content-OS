import { ERROR_DEFINITIONS } from '@geo-content-os/contracts';
import {
  type WebFetchAdapter,
  WebFetchBlockedError,
  WebFetchResponseError,
  WebFetchSizeError,
  WebFetchTimeoutError,
  WebFetchValidationError,
} from '@geo-content-os/adapter-web-fetch';
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
import {
  parseSourceUpload,
  type ParsedSourceSubmission,
  type ParsedSourceUpload,
} from './source-upload.parser.js';
import { SOURCE_WEB_FETCH } from './source.tokens.js';

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
    @Inject(SOURCE_WEB_FETCH) private readonly webFetch: WebFetchAdapter,
  ) {}

  @Post()
  @RequirePermissions('knowledge.sources.manage')
  public async upload(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    try {
      const submission = await parseSourceUpload(request, this.configuration.maxFileBytes);
      const input = await resolveSubmission(submission, this.webFetch);
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
              ...(input.kind === 'file'
                ? { filename: input.filename }
                : {
                    final_url: input.finalUrl,
                    requested_url:
                      submission.kind === 'url-submission'
                        ? submission.requestedUrl
                        : input.finalUrl,
                  }),
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

async function resolveSubmission(
  submission: ParsedSourceSubmission,
  webFetch: WebFetchAdapter,
): Promise<ParsedSourceUpload> {
  if (submission.kind === 'file') return submission;
  try {
    const fetched = await webFetch.fetch(submission.requestedUrl);
    return {
      body: fetched.body,
      contentHash: fetched.contentHash,
      effectiveFrom: submission.effectiveFrom,
      effectiveTo: submission.effectiveTo,
      finalUrl: fetched.finalUrl,
      kind: 'url',
      language: submission.language,
      mimeType: fetched.contentType,
      projectId: submission.projectId,
      redirectChain: fetched.redirectChain,
      sourceType: 'url',
      title: submission.title,
      trustLevel: submission.trustLevel,
      workspaceId: submission.workspaceId,
    };
  } catch (error) {
    if (
      error instanceof WebFetchBlockedError ||
      error instanceof WebFetchResponseError ||
      error instanceof WebFetchSizeError ||
      error instanceof WebFetchTimeoutError ||
      error instanceof WebFetchValidationError
    ) {
      throw new SourceUploadValidationError('URL source failed security or response validation');
    }
    throw error;
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
