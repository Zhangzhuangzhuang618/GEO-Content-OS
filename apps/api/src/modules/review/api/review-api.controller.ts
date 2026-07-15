import {
  ERROR_DEFINITIONS,
  RequestSignoffRequestSchema,
  ReviewDecisionRequestSchema,
  ReviewInboxQuerySchema,
  ReviewSnapshotParamsSchema,
  SubmitReviewRequestSchema,
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
import type { TransactionSql } from 'postgres';

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
import { ReviewDecisionError } from '../decisions/index.js';
import { SubmitReviewError } from '../submit/index.js';
import { ReviewApiError } from './review-api.errors.js';
import { ReviewApiService } from './review-api.service.js';

interface TenantPolicy {
  readonly tenantId: string;
  readonly userId: string;
}

@Controller('content-packages')
@UseGuards(PolicyGuard)
export class ReviewSubmissionController {
  public constructor(
    @Inject(ReviewApiService) private readonly review: ReviewApiService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  @Post(':id/submit-review')
  @RequirePermissions('content.production.manage')
  public async submit(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsedParams = ReviewSnapshotParamsSchema.safeParse(params);
    const parsedBody = SubmitReviewRequestSchema.safeParse(body);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    return idempotent(
      this.idempotency,
      reply,
      request,
      `/content-packages/${parsedParams.data.id}/submit-review`,
      parsedBody.data as JsonValue,
      async (transaction, policy) =>
        response(
          await this.review.submit(
            transaction,
            policy.tenantId,
            policy.userId,
            parsedParams.data.id,
            parsedBody.data,
            audit(request),
          ),
          request.id,
        ),
      HttpStatus.CREATED,
      'data.version',
    );
  }
}

@Controller('review-snapshots')
@UseGuards(PolicyGuard)
export class ReviewSnapshotController {
  public constructor(
    @Inject(ReviewApiService) private readonly review: ReviewApiService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @RequirePermissions('review.decide')
  public async list(
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = ReviewInboxQuerySchema.safeParse(query);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requirePolicy(request);
      const page = await this.review.list(policy.tenantId, policy.userId, parsed.data);
      await reply.status(HttpStatus.OK).send({
        data: page.items,
        meta: { next_cursor: page.nextCursor, request_id: request.id },
      });
    } catch (error) {
      await sendReviewError(reply, request.id, error);
    }
  }

  @Get(':id')
  @RequirePermissions('review.decide')
  public async detail(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = ReviewSnapshotParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requirePolicy(request);
      const data = await this.review.detail(policy.tenantId, policy.userId, parsed.data.id);
      await reply
        .header('ETag', quoteVersion(readVersion(data, 'snapshot.version')))
        .status(HttpStatus.OK)
        .send(response(data, request.id));
    } catch (error) {
      await sendReviewError(reply, request.id, error);
    }
  }

  @Post(':id/approve')
  @RequirePermissions('review.decide')
  public approve(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.decision('approve', params, body, request, reply);
  }

  @Post(':id/reject')
  @RequirePermissions('review.decide')
  public reject(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.decision('reject', params, body, request, reply);
  }

  @Post(':id/request-signoff')
  @RequirePermissions('review.decide')
  public async requestSignoff(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsedParams = ReviewSnapshotParamsSchema.safeParse(params);
    const parsedBody = RequestSignoffRequestSchema.safeParse(body);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    let version: number;
    try {
      version = parseIfMatch(request.headers['if-match']);
    } catch (error) {
      return sendReviewError(reply, request.id, error);
    }
    return idempotent(
      this.idempotency,
      reply,
      request,
      `/review-snapshots/${parsedParams.data.id}/request-signoff`,
      parsedBody.data as JsonValue,
      async (transaction, policy) =>
        response(
          await this.review.requestSignoff(
            transaction,
            policy.tenantId,
            policy.userId,
            parsedParams.data.id,
            parsedBody.data,
            version,
            audit(request),
          ),
          request.id,
        ),
      HttpStatus.CREATED,
      undefined,
      version,
      version + 1,
    );
  }

  @Get(':id/actions')
  @RequirePermissions('review.read')
  public async actions(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = ReviewSnapshotParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requirePolicy(request);
      const actions = await this.review.actions(policy.tenantId, policy.userId, parsed.data.id);
      await reply.status(HttpStatus.OK).send({ data: actions, meta: { request_id: request.id } });
    } catch (error) {
      await sendReviewError(reply, request.id, error);
    }
  }

  private async decision(
    decision: 'approve' | 'reject',
    params: unknown,
    body: unknown,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const parsedParams = ReviewSnapshotParamsSchema.safeParse(params);
    const parsedBody = ReviewDecisionRequestSchema.safeParse(body);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    let version: number;
    try {
      version = parseIfMatch(request.headers['if-match']);
    } catch (error) {
      return sendReviewError(reply, request.id, error);
    }
    return idempotent(
      this.idempotency,
      reply,
      request,
      `/review-snapshots/${parsedParams.data.id}/${decision}`,
      parsedBody.data as JsonValue,
      async (transaction, policy) =>
        response(
          await this.review.decide(
            transaction,
            policy.tenantId,
            policy.userId,
            parsedParams.data.id,
            parsedBody.data,
            version,
            decision,
            audit(request),
          ),
          request.id,
        ),
      HttpStatus.OK,
      'data.snapshot.version',
      version,
    );
  }
}

async function idempotent(
  service: IdempotencyService,
  reply: FastifyReply,
  request: FastifyRequest,
  route: string,
  body: JsonValue,
  operation: (transaction: TransactionSql, policy: TenantPolicy) => Promise<JsonValue>,
  statusCode: number,
  etagPath?: string,
  version?: number,
  fixedEtagVersion?: number,
) {
  try {
    const policy = requirePolicy(request);
    const result = await service.execute(
      {
        fingerprint: {
          body,
          method: request.method,
          path: route,
          ...(version ? { query: { version } } : {}),
        },
        idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
        scopeKey: buildIdempotencyScope({
          actorId: policy.userId,
          method: request.method,
          route,
        }),
        tenantId: policy.tenantId,
      },
      async (transaction) => ({
        body: await operation(transaction, policy),
        statusCode,
      }),
    );
    if (etagPath) reply.header('ETag', quoteVersion(readVersion(result.response.body, etagPath)));
    else if (fixedEtagVersion) reply.header('ETag', quoteVersion(fixedEtagVersion));
    await reply.status(result.response.statusCode).send(result.response.body);
  } catch (error) {
    await sendReviewError(reply, request.id, error);
  }
}

interface Issue {
  readonly code: string;
  readonly path: PropertyKey[];
}

function issues(
  ...results: readonly (
    { success: true } | { success: false; error: { issues: readonly Issue[] } }
  )[]
): readonly Issue[] {
  return results.flatMap((result) => (result.success ? [] : result.error.issues));
}

function requirePolicy(request: FastifyRequest): TenantPolicy {
  const policy = getPolicyContext(request);
  if (!policy?.activeTenantId)
    throw new Error('PolicyGuard did not attach an active tenant context');
  return { tenantId: policy.activeTenantId, userId: policy.userId };
}

function parseIfMatch(value: string | string[] | undefined): number {
  if (Array.isArray(value) || typeof value !== 'string' || value.startsWith('W/')) {
    throw new ReviewApiError(
      'validation',
      'If-Match must contain a strong positive integer version',
    );
  }
  const match = /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/u.exec(value.trim());
  const version = Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ReviewApiError('validation', 'If-Match is invalid');
  }
  return version;
}

function audit(request: FastifyRequest) {
  return { ...(request.ip ? { ip: request.ip } : {}), requestId: request.id };
}

function response(data: JsonValue, requestId: string): JsonValue {
  return { data, meta: { request_id: requestId } };
}

function readVersion(value: JsonValue, path: string): number {
  let current: JsonValue | undefined = value;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`Missing response ${path}`);
    }
    current = (current as { readonly [key: string]: JsonValue })[key];
  }
  if (!Number.isSafeInteger(current) || (current as number) < 1) {
    throw new Error(`Invalid response ${path}`);
  }
  return current as number;
}

function quoteVersion(version: number): string {
  return `"${version}"`;
}

async function sendSchemaError(
  reply: FastifyReply,
  requestId: string,
  validationIssues: readonly Issue[],
) {
  await reply.status(HttpStatus.UNPROCESSABLE_ENTITY).send({
    error: {
      code: 'SCHEMA_VALIDATION_FAILED',
      details: {
        issues: validationIssues.map((issue) => ({ code: issue.code, path: issue.path })),
      },
      message: ERROR_DEFINITIONS.SCHEMA_VALIDATION_FAILED.message,
      request_id: requestId,
    },
  });
}

async function sendReviewError(reply: FastifyReply, requestId: string, error: unknown) {
  let code:
    | 'IDEMPOTENCY_CONFLICT'
    | 'PERMISSION_DENIED'
    | 'RESOURCE_NOT_FOUND'
    | 'SCHEMA_VALIDATION_FAILED'
    | 'STATE_TRANSITION_INVALID'
    | 'VERSION_CONFLICT'
    | undefined;
  if (error instanceof ReviewApiError) {
    code =
      error.kind === 'not_found'
        ? 'RESOURCE_NOT_FOUND'
        : error.kind === 'permission'
          ? 'PERMISSION_DENIED'
          : error.kind === 'validation'
            ? 'SCHEMA_VALIDATION_FAILED'
            : error.kind === 'version'
              ? 'VERSION_CONFLICT'
              : 'STATE_TRANSITION_INVALID';
  } else if (error instanceof ReviewDecisionError) {
    code = error.code.includes('NOT_FOUND')
      ? 'RESOURCE_NOT_FOUND'
      : error.code.includes('PERMISSION')
        ? 'PERMISSION_DENIED'
        : error.code.includes('INPUT')
          ? 'SCHEMA_VALIDATION_FAILED'
          : error.code.includes('VERSION')
            ? 'VERSION_CONFLICT'
            : 'STATE_TRANSITION_INVALID';
  } else if (error instanceof SubmitReviewError) {
    code = error.code.includes('NOT_FOUND')
      ? 'RESOURCE_NOT_FOUND'
      : error.code.includes('INPUT')
        ? 'SCHEMA_VALIDATION_FAILED'
        : error.code.includes('VERSION')
          ? 'VERSION_CONFLICT'
          : 'STATE_TRANSITION_INVALID';
  } else if (error instanceof IdempotencyConflictError) code = 'IDEMPOTENCY_CONFLICT';
  else if (error instanceof IdempotencyKeyValidationError) code = 'SCHEMA_VALIDATION_FAILED';
  else if (error instanceof IdempotencyProcessingError) code = 'STATE_TRANSITION_INVALID';
  if (!code) throw error;
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: { code, message: ERROR_DEFINITIONS[code].message, request_id: requestId },
  });
}
