import {
  CompareVersionQuerySchema,
  ContentBlockParamsSchema,
  ContentIdSchema,
  ContentPackageQuerySchema,
  CreateContentPackageRequestSchema,
  DropVariantRequestSchema,
  ERROR_DEFINITIONS,
  GenerateContentRequestSchema,
  LockBlockRequestSchema,
  QualityCheckRequestSchema,
  ReasonRequestSchema,
  RegenerateVariantRequestSchema,
  ReopenVariantsRequestSchema,
  RollbackRequestSchema,
  UpdateVariantRequestSchema,
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
import { GenerationOrchestrationError } from '../../ai/orchestrator/index.js';
import { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import { getPolicyContext, PolicyGuard, RequirePermissions } from '../../identity/rbac/index.js';
import {
  ContentBlockLockNotFoundError,
  ContentBlockLockStateError,
  ContentBlockLockValidationError,
  ContentBlockLockVersionConflictError,
  ContentBlockLockViolationError,
} from '../block-locks/index.js';
import {
  ContentPackageNotFoundError,
  ContentPackageStateError,
  ContentPackageVersionConflictError,
} from '../packages/index.js';
import {
  ContentVariantNotFoundError,
  ContentVariantStateError,
  ContentVariantVersionConflictError,
} from '../variants/index.js';
import {
  ContentVersionNotFoundError,
  ContentVersionStateError,
  ContentVersionValidationError,
  ContentVersionVersionConflictError,
} from '../versions/index.js';
import { ContentApiError } from './content-api.errors.js';
import { ContentApiService } from './content-api.service.js';

type ContentErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID'
  | 'VERSION_CONFLICT';

interface TenantPolicy {
  readonly tenantId: string;
  readonly userId: string;
}

@Controller('content-packages')
@UseGuards(PolicyGuard)
export class ContentPackageController {
  public constructor(
    @Inject(ContentApiService) private readonly content: ContentApiService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  @Post()
  @RequirePermissions('content.production.manage')
  public async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = CreateContentPackageRequestSchema.safeParse(body);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    return this.idempotent(
      reply,
      request,
      '/content-packages',
      parsed.data as JsonValue,
      undefined,
      async (transaction, policy) => ({
        body: response(
          await this.content.createPackage(
            transaction,
            policy.tenantId,
            policy.userId,
            parsed.data,
            audit(request),
          ),
          request.id,
        ),
        statusCode: HttpStatus.CREATED,
      }),
      'data.version',
    );
  }

  @Get()
  @RequirePermissions('content.read')
  public async list(
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = ContentPackageQuerySchema.safeParse(query);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requirePolicy(request);
      const page = await this.content.listPackages(policy.tenantId, policy.userId, parsed.data);
      await reply.status(HttpStatus.OK).send({
        data: page.items,
        meta: { next_cursor: page.nextCursor, request_id: request.id },
      });
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }

  @Get(':id')
  @RequirePermissions('content.read')
  public async find(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = ContentIdSchema.safeParse(id);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requirePolicy(request);
      const detail = await this.content.getPackage(policy.tenantId, policy.userId, parsed.data);
      await reply
        .header('ETag', quoteVersion(readVersion(detail, 'package.version')))
        .status(HttpStatus.OK)
        .send(response(detail, request.id));
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }

  @Post(':id/generate')
  @RequirePermissions('content.production.manage')
  public async generate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsedId = ContentIdSchema.safeParse(id);
    const parsedBody = GenerateContentRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success)
      return sendSchemaError(reply, request.id, issues(parsedId, parsedBody));
    let expectedVersion: number;
    try {
      expectedVersion = parseIfMatch(request.headers['if-match']);
    } catch (error) {
      return sendContentError(reply, request.id, error);
    }
    const route = `/content-packages/${parsedId.data}/generate`;
    return this.idempotent(
      reply,
      request,
      route,
      parsedBody.data as JsonValue,
      expectedVersion,
      async (transaction, policy) => ({
        body: response(
          await this.content.generatePackage(
            transaction,
            policy.tenantId,
            policy.userId,
            parsedId.data,
            expectedVersion,
            parsedBody.data,
            audit(request),
          ),
          request.id,
        ),
        statusCode: HttpStatus.ACCEPTED,
      }),
    );
  }

  @Post(':id/abandon')
  @RequirePermissions('content.production.manage')
  public abandon(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.versionedPackageMutation(
      id,
      body,
      request,
      reply,
      (transaction, policy, packageId, version, reason) =>
        this.content.abandonPackage(
          transaction,
          policy.tenantId,
          policy.userId,
          packageId,
          version,
          reason,
          audit(request),
        ),
    );
  }

  @Post(':id/archive')
  @RequirePermissions('tenant.workspaces.manage')
  public archive(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.versionedPackageMutation(
      id,
      body,
      request,
      reply,
      (transaction, policy, packageId, version, reason) =>
        this.content.archivePackage(
          transaction,
          policy.tenantId,
          policy.userId,
          packageId,
          version,
          reason,
          audit(request),
        ),
    );
  }

  @Post(':id/reopen')
  @RequirePermissions('review.decide')
  public async reopen(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsedId = ContentIdSchema.safeParse(id);
    const parsedBody = ReopenVariantsRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success)
      return sendSchemaError(reply, request.id, issues(parsedId, parsedBody));
    let expectedVersion: number;
    try {
      expectedVersion = parseIfMatch(request.headers['if-match']);
    } catch (error) {
      return sendContentError(reply, request.id, error);
    }
    const route = `/content-packages/${parsedId.data}/reopen`;
    return this.idempotent(
      reply,
      request,
      route,
      parsedBody.data as JsonValue,
      expectedVersion,
      async (transaction, policy) => ({
        body: response(
          await this.content.reopenPackage(
            transaction,
            policy.tenantId,
            policy.userId,
            parsedId.data,
            expectedVersion,
            parsedBody.data,
            audit(request),
          ),
          request.id,
        ),
        statusCode: HttpStatus.OK,
      }),
      'data.package.version',
      true,
    );
  }

  private async versionedPackageMutation(
    id: string,
    body: unknown,
    request: FastifyRequest,
    reply: FastifyReply,
    operation: (
      transaction: TransactionSql,
      policy: TenantPolicy,
      id: string,
      version: number,
      reason: string,
    ) => Promise<JsonValue>,
  ) {
    const parsedId = ContentIdSchema.safeParse(id);
    const parsedBody = ReasonRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success)
      return sendSchemaError(reply, request.id, issues(parsedId, parsedBody));
    try {
      const policy = requirePolicy(request);
      const expectedVersion = parseIfMatch(request.headers['if-match']);
      const data = await this.database.client.begin((transaction) =>
        operation(transaction, policy, parsedId.data, expectedVersion, parsedBody.data.reason),
      );
      await reply
        .header('ETag', quoteVersion(readVersion(data, 'version')))
        .status(HttpStatus.OK)
        .send(response(data, request.id));
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }

  private async idempotent(
    reply: FastifyReply,
    request: FastifyRequest,
    route: string,
    body: JsonValue,
    version: number | undefined,
    operation: (
      transaction: TransactionSql,
      policy: TenantPolicy,
    ) => Promise<{ body: JsonValue; statusCode: number }>,
    etagPath?: string,
    includeVersionInFingerprint = false,
  ) {
    try {
      const policy = requirePolicy(request);
      const result = await this.idempotency.execute(
        {
          fingerprint: {
            body,
            method: request.method,
            path: route,
            ...(includeVersionInFingerprint && version ? { query: { version } } : {}),
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId: policy.userId,
            method: request.method,
            route,
          }),
          tenantId: policy.tenantId,
        },
        (transaction) => operation(transaction, policy),
      );
      if (etagPath) reply.header('ETag', quoteVersion(readVersion(result.response.body, etagPath)));
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }
}

@Controller('generation-runs')
@UseGuards(PolicyGuard)
export class GenerationRunController {
  public constructor(
    @Inject(ContentApiService) private readonly content: ContentApiService,
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  @Get(':id')
  @RequirePermissions('content.production.manage')
  public async find(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = ContentIdSchema.safeParse(id);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requirePolicy(request);
      const run = await this.content.getRun(policy.tenantId, policy.userId, parsed.data);
      await reply
        .header('ETag', quoteVersion(readVersion(run, 'version')))
        .status(HttpStatus.OK)
        .send(response(run, request.id));
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }

  @Post(':id/cancel')
  @RequirePermissions('content.production.manage')
  public async cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsedId = ContentIdSchema.safeParse(id);
    const parsedBody = ReasonRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success)
      return sendSchemaError(reply, request.id, issues(parsedId, parsedBody));
    try {
      const policy = requirePolicy(request);
      const version = parseIfMatch(request.headers['if-match']);
      const run = await this.database.client.begin((transaction) =>
        this.content.cancelRun(
          transaction,
          policy.tenantId,
          policy.userId,
          parsedId.data,
          version,
          parsedBody.data.reason,
          audit(request),
        ),
      );
      await reply
        .header('ETag', quoteVersion(readVersion(run, 'version')))
        .status(HttpStatus.OK)
        .send(response(run, request.id));
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }
}

@Controller('content-versions')
@UseGuards(PolicyGuard)
export class ContentVersionController {
  public constructor(
    @Inject(ContentApiService) private readonly content: ContentApiService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  @Get(':id')
  @RequirePermissions('content.read')
  public async find(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = ContentIdSchema.safeParse(id);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requirePolicy(request);
      await reply
        .status(HttpStatus.OK)
        .send(
          response(
            await this.content.getVersion(policy.tenantId, policy.userId, parsed.data),
            request.id,
          ),
        );
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }

  @Get(':id/diff')
  @RequirePermissions('content.read')
  public async diff(
    @Param('id') id: string,
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsedId = ContentIdSchema.safeParse(id);
    const parsedQuery = CompareVersionQuerySchema.safeParse(query);
    if (!parsedId.success || !parsedQuery.success)
      return sendSchemaError(reply, request.id, issues(parsedId, parsedQuery));
    try {
      const policy = requirePolicy(request);
      await reply
        .status(HttpStatus.OK)
        .send(
          response(
            await this.content.diffVersion(
              policy.tenantId,
              policy.userId,
              parsedId.data,
              parsedQuery.data.target_version_id,
            ),
            request.id,
          ),
        );
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }

  @Post(':id/rollback')
  @RequirePermissions('content.production.manage')
  public async rollback(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsedId = ContentIdSchema.safeParse(id);
    const parsedBody = RollbackRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success)
      return sendSchemaError(reply, request.id, issues(parsedId, parsedBody));
    try {
      const policy = requirePolicy(request);
      const version = parseIfMatch(request.headers['if-match']);
      const route = `/content-versions/${parsedId.data}/rollback`;
      const result = await this.idempotency.execute(
        {
          fingerprint: {
            body: parsedBody.data as JsonValue,
            method: request.method,
            path: route,
            query: { version },
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
          body: response(
            await this.content.rollbackVersion(
              transaction,
              policy.tenantId,
              policy.userId,
              parsedId.data,
              version,
              audit(request),
            ),
            request.id,
          ),
          statusCode: HttpStatus.OK,
        }),
      );
      await reply
        .header('ETag', quoteVersion(version + 1))
        .status(result.response.statusCode)
        .send(result.response.body);
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }
}

@Controller('content-variants')
@UseGuards(PolicyGuard)
export class ContentVariantController {
  public constructor(
    @Inject(ContentApiService) private readonly content: ContentApiService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  @Get(':id')
  @RequirePermissions('content.read')
  public async find(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = ContentIdSchema.safeParse(id);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requirePolicy(request);
      const detail = await this.content.getVariant(policy.tenantId, policy.userId, parsed.data);
      await reply
        .header('ETag', quoteVersion(readVersion(detail, 'variant.version')))
        .status(HttpStatus.OK)
        .send(response(detail, request.id));
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }

  @Patch(':id')
  @RequirePermissions('content.production.manage')
  public update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.idempotentVariant(
      id,
      body,
      request,
      reply,
      UpdateVariantRequestSchema,
      '',
      async (transaction, policy, variantId, version, data) =>
        this.content.updateVariant(
          transaction,
          policy.tenantId,
          policy.userId,
          variantId,
          version,
          data.content,
          audit(request),
        ),
      HttpStatus.OK,
      true,
      true,
      'data.variant.version',
    );
  }

  @Post(':id/blocks/:blockId/lock')
  @RequirePermissions('content.production.manage')
  public async lock(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsedParams = ContentBlockParamsSchema.safeParse(params);
    const parsedBody = LockBlockRequestSchema.safeParse(body);
    if (!parsedParams.success || !parsedBody.success)
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    try {
      const policy = requirePolicy(request);
      const version = parseIfMatch(request.headers['if-match']);
      const lock = await this.database.client.begin((transaction) =>
        this.content.lockBlock(
          transaction,
          policy.tenantId,
          policy.userId,
          parsedParams.data.id,
          parsedParams.data.blockId,
          version,
          parsedBody.data.reason,
          audit(request),
        ),
      );
      await reply
        .header('ETag', quoteVersion(readVersion(lock, 'variant_version')))
        .status(HttpStatus.CREATED)
        .send(response(lock, request.id));
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }

  @Delete(':id/blocks/:blockId/lock')
  @RequirePermissions('content.production.manage')
  public async unlock(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = ContentBlockParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const policy = requirePolicy(request);
      const version = parseIfMatch(request.headers['if-match']);
      await this.database.client.begin((transaction) =>
        this.content.unlockBlock(
          transaction,
          policy.tenantId,
          policy.userId,
          parsed.data.id,
          parsed.data.blockId,
          version,
          audit(request),
        ),
      );
      await reply.status(HttpStatus.NO_CONTENT).send();
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }

  @Post(':id/quality-check')
  @RequirePermissions('content.production.manage')
  public async quality(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsedId = ContentIdSchema.safeParse(id);
    const parsedBody = QualityCheckRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success)
      return sendSchemaError(reply, request.id, issues(parsedId, parsedBody));
    try {
      const policy = requirePolicy(request);
      const contentHash = await this.content.getVariantContentHash(
        policy.tenantId,
        policy.userId,
        parsedId.data,
      );
      const route = `/content-variants/${parsedId.data}/quality-check`;
      const result = await this.idempotency.execute(
        {
          fingerprint: {
            body: parsedBody.data as JsonValue,
            method: request.method,
            path: route,
            query: { content_hash: contentHash },
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
          body: response(
            await this.content.requestQualityCheck(
              transaction,
              policy.tenantId,
              policy.userId,
              parsedId.data,
              contentHash,
              audit(request),
              parsedBody.data,
            ),
            request.id,
          ),
          statusCode: HttpStatus.ACCEPTED,
        }),
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }

  @Post(':id/regenerate')
  @RequirePermissions('content.production.manage')
  public regenerate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.idempotentVariant(
      id,
      body,
      request,
      reply,
      RegenerateVariantRequestSchema,
      'regenerate',
      (transaction, policy, variantId, version, data) =>
        this.content.regenerateVariant(
          transaction,
          policy.tenantId,
          policy.userId,
          variantId,
          version,
          data,
          audit(request),
        ),
      HttpStatus.ACCEPTED,
      true,
      false,
    );
  }

  @Post(':id/drop')
  @RequirePermissions('content.production.manage')
  public async drop(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsedId = ContentIdSchema.safeParse(id);
    const parsedBody = DropVariantRequestSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success)
      return sendSchemaError(reply, request.id, issues(parsedId, parsedBody));
    try {
      const policy = requirePolicy(request);
      const version = parseIfMatch(request.headers['if-match']);
      const detail = await this.database.client.begin((transaction) =>
        this.content.dropVariant(
          transaction,
          policy.tenantId,
          policy.userId,
          parsedId.data,
          version,
          parsedBody.data.reason,
          audit(request),
        ),
      );
      await reply
        .header('ETag', quoteVersion(readVersion(detail, 'variant.version')))
        .status(HttpStatus.OK)
        .send(response(detail, request.id));
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
  }

  private async idempotentVariant<TData extends Record<string, unknown>>(
    id: string,
    body: unknown,
    request: FastifyRequest,
    reply: FastifyReply,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: TData } | { success: false; error: { issues: readonly Issue[] } };
    },
    action: string,
    operation: (
      transaction: TransactionSql,
      policy: TenantPolicy,
      id: string,
      version: number,
      data: TData,
    ) => Promise<JsonValue>,
    statusCode = HttpStatus.OK,
    requireVersion = true,
    includeVersionInFingerprint = false,
    etagPath?: string,
  ) {
    const parsedId = ContentIdSchema.safeParse(id);
    const parsedBody = schema.safeParse(body);
    if (!parsedId.success || !parsedBody.success)
      return sendSchemaError(reply, request.id, issues(parsedId, parsedBody));
    try {
      const policy = requirePolicy(request);
      const version = requireVersion ? parseIfMatch(request.headers['if-match']) : 1;
      const route = `/content-variants/${parsedId.data}${action ? `/${action}` : ''}`;
      const result = await this.idempotency.execute(
        {
          fingerprint: {
            body: parsedBody.data as JsonValue,
            method: request.method,
            path: route,
            ...(includeVersionInFingerprint ? { query: { version } } : {}),
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
          body: response(
            await operation(transaction, policy, parsedId.data, version, parsedBody.data),
            request.id,
          ),
          statusCode,
        }),
      );
      if (etagPath) reply.header('ETag', quoteVersion(readVersion(result.response.body, etagPath)));
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendContentError(reply, request.id, error);
    }
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
    throw new ContentApiError(
      'validation',
      'If-Match must contain a strong positive integer version',
    );
  }
  const match = /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/u.exec(value.trim());
  const version = Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new ContentApiError('validation', 'If-Match is invalid');
  return version;
}

function quoteVersion(version: number) {
  return `"${version}"`;
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
    if (!current || typeof current !== 'object' || Array.isArray(current))
      throw new Error(`Missing response ${path}`);
    current = (current as { readonly [key: string]: JsonValue })[key];
  }
  if (!Number.isSafeInteger(current) || (current as number) < 1)
    throw new Error(`Invalid response ${path}`);
  return current as number;
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

async function sendContentError(reply: FastifyReply, requestId: string, error: unknown) {
  let code: ContentErrorCode | undefined;
  if (error instanceof ContentApiError) {
    code =
      error.kind === 'not_found'
        ? 'RESOURCE_NOT_FOUND'
        : error.kind === 'version'
          ? 'VERSION_CONFLICT'
          : error.kind === 'validation'
            ? 'SCHEMA_VALIDATION_FAILED'
            : 'STATE_TRANSITION_INVALID';
  } else if (error instanceof IdempotencyConflictError) code = 'IDEMPOTENCY_CONFLICT';
  else if (
    error instanceof IdempotencyKeyValidationError ||
    error instanceof ContentVersionValidationError ||
    error instanceof ContentBlockLockValidationError
  )
    code = 'SCHEMA_VALIDATION_FAILED';
  else if (
    error instanceof ContentPackageNotFoundError ||
    error instanceof ContentVariantNotFoundError ||
    error instanceof ContentVersionNotFoundError ||
    error instanceof ContentBlockLockNotFoundError
  )
    code = 'RESOURCE_NOT_FOUND';
  else if (
    error instanceof ContentPackageVersionConflictError ||
    error instanceof ContentVariantVersionConflictError ||
    error instanceof ContentVersionVersionConflictError ||
    error instanceof ContentBlockLockVersionConflictError
  )
    code = 'VERSION_CONFLICT';
  else if (
    error instanceof ContentPackageStateError ||
    error instanceof ContentVariantStateError ||
    error instanceof ContentVersionStateError ||
    error instanceof ContentBlockLockStateError ||
    error instanceof ContentBlockLockViolationError ||
    error instanceof IdempotencyProcessingError
  )
    code = 'STATE_TRANSITION_INVALID';
  else if (error instanceof GenerationOrchestrationError) {
    code = error.code.includes('NOT_FOUND')
      ? 'RESOURCE_NOT_FOUND'
      : error.code.includes('VERSION')
        ? 'VERSION_CONFLICT'
        : error.code.includes('INPUT')
          ? 'SCHEMA_VALIDATION_FAILED'
          : 'STATE_TRANSITION_INVALID';
  } else if (isConstraintError(error)) code = 'STATE_TRANSITION_INVALID';
  if (!code) throw error;
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: { code, message: ERROR_DEFINITIONS[code].message, request_id: requestId },
  });
}

function isConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return ['23503', '23505', '23514'].includes(String((error as { code?: unknown }).code));
}
