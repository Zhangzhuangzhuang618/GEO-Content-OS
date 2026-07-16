import {
  CreatePromptVersionRequestSchema,
  CreateRuleVersionRequestSchema,
  ERROR_DEFINITIONS,
  PlatformConfigIdSchema,
  PromptVersionQuerySchema,
  PublishPlatformVersionRequestSchema,
  RetirePlatformVersionRequestSchema,
  RuleVersionQuerySchema,
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
  PlatformConfigConflictError,
  PlatformConfigNotFoundError,
  PlatformConfigStateError,
  PlatformConfigValidationError,
  PlatformConfigVersionError,
} from './platform-config.errors.js';
import { PlatformConfigService } from './platform-config.service.js';

type PlatformConfigErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID'
  | 'VERSION_CONFLICT';

@Controller('platform')
@UseGuards(PolicyGuard)
export class PlatformConfigController {
  public constructor(
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(PlatformConfigService) private readonly configs: PlatformConfigService,
  ) {}

  @Get('prompt-versions')
  @RequirePermissions('platform.prompts.manage')
  public async listPrompts(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const query = PromptVersionQuerySchema.safeParse(raw);
    if (!query.success) return sendSchemaError(reply, request.id, query.error.issues);
    try {
      const page = await this.configs.listPrompts(query.data);
      await sendPage(reply, request.id, page);
    } catch (error) {
      await sendPlatformConfigError(reply, request.id, error);
    }
  }

  @Post('prompt-versions')
  @RequirePermissions('platform.prompts.manage')
  public async createPrompt(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const body = CreatePromptVersionRequestSchema.safeParse(raw);
    if (!body.success) return sendSchemaError(reply, request.id, body.error.issues);
    const actorId = requireActor(request);
    try {
      const result = await this.idempotency.execute(
        {
          fingerprint: {
            body: body.data as JsonValue,
            method: request.method,
            path: '/platform/prompt-versions',
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId,
            method: request.method,
            route: '/platform/prompt-versions',
          }),
          tenantId: null,
        },
        async (transaction) => {
          const created = await this.configs.createPrompt(
            transaction,
            actorId,
            body.data,
            auditContext(request),
          );
          return {
            body: toJson({ data: created, meta: { request_id: request.id } }),
            statusCode: HttpStatus.CREATED,
          };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendPlatformConfigError(reply, request.id, error);
    }
  }

  @Post('prompt-versions/:id/publish')
  @RequirePermissions('platform.prompts.manage')
  public async publishPrompt(
    @Param('id') rawId: string,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = parseTransition(rawId, raw, request.headers['if-match']);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.issues);
    try {
      const view = await this.configs.publishPrompt(
        requireActor(request),
        parsed.id,
        parsed.version,
        auditContext(request),
      );
      await sendView(reply, request.id, view);
    } catch (error) {
      await sendPlatformConfigError(reply, request.id, error);
    }
  }

  @Post('prompt-versions/:id/retire')
  @RequirePermissions('platform.prompts.manage')
  public async retirePrompt(
    @Param('id') rawId: string,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const id = PlatformConfigIdSchema.safeParse(rawId);
    const body = RetirePlatformVersionRequestSchema.safeParse(raw);
    const version = parseIfMatch(request.headers['if-match']);
    if (!id.success || !body.success || version === null) {
      return sendSchemaError(reply, request.id, [
        ...(id.success ? [] : id.error.issues),
        ...(body.success ? [] : body.error.issues),
        ...(version === null ? [headerIssue()] : []),
      ]);
    }
    try {
      const view = await this.configs.retirePrompt(
        requireActor(request),
        id.data,
        version,
        body.data.reason,
        auditContext(request),
      );
      await sendView(reply, request.id, view);
    } catch (error) {
      await sendPlatformConfigError(reply, request.id, error);
    }
  }

  @Get('rule-versions')
  @RequirePermissions('platform.rules.manage')
  public async listRules(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const query = RuleVersionQuerySchema.safeParse(raw);
    if (!query.success) return sendSchemaError(reply, request.id, query.error.issues);
    try {
      const page = await this.configs.listRules(query.data);
      await sendPage(reply, request.id, page);
    } catch (error) {
      await sendPlatformConfigError(reply, request.id, error);
    }
  }

  @Post('rule-versions')
  @RequirePermissions('platform.rules.manage')
  public async createRule(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const body = CreateRuleVersionRequestSchema.safeParse(raw);
    if (!body.success) return sendSchemaError(reply, request.id, body.error.issues);
    const actorId = requireActor(request);
    try {
      const result = await this.idempotency.execute(
        {
          fingerprint: {
            body: body.data as JsonValue,
            method: request.method,
            path: '/platform/rule-versions',
          },
          idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
          scopeKey: buildIdempotencyScope({
            actorId,
            method: request.method,
            route: '/platform/rule-versions',
          }),
          tenantId: null,
        },
        async (transaction) => {
          const created = await this.configs.createRule(
            transaction,
            actorId,
            body.data,
            auditContext(request),
          );
          return {
            body: toJson({ data: created, meta: { request_id: request.id } }),
            statusCode: HttpStatus.CREATED,
          };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      await sendPlatformConfigError(reply, request.id, error);
    }
  }

  @Post('rule-versions/:id/publish')
  @RequirePermissions('platform.rules.manage')
  public async publishRule(
    @Param('id') rawId: string,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = parseTransition(rawId, raw, request.headers['if-match']);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.issues);
    try {
      const view = await this.configs.publishRule(
        requireActor(request),
        parsed.id,
        parsed.version,
        auditContext(request),
      );
      await sendView(reply, request.id, view);
    } catch (error) {
      await sendPlatformConfigError(reply, request.id, error);
    }
  }

  @Post('rule-versions/:id/retire')
  @RequirePermissions('platform.rules.manage')
  public async retireRule(
    @Param('id') rawId: string,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const id = PlatformConfigIdSchema.safeParse(rawId);
    const body = RetirePlatformVersionRequestSchema.safeParse(raw);
    const version = parseIfMatch(request.headers['if-match']);
    if (!id.success || !body.success || version === null) {
      return sendSchemaError(reply, request.id, [
        ...(id.success ? [] : id.error.issues),
        ...(body.success ? [] : body.error.issues),
        ...(version === null ? [headerIssue()] : []),
      ]);
    }
    try {
      const view = await this.configs.retireRule(
        requireActor(request),
        id.data,
        version,
        body.data.reason,
        auditContext(request),
      );
      await sendView(reply, request.id, view);
    } catch (error) {
      await sendPlatformConfigError(reply, request.id, error);
    }
  }
}

function parseTransition(
  rawId: string,
  rawBody: unknown,
  ifMatch: string | string[] | undefined,
):
  | { readonly success: true; readonly id: string; readonly version: number }
  | {
      readonly success: false;
      readonly issues: readonly { readonly code: string; readonly path: PropertyKey[] }[];
    } {
  const id = PlatformConfigIdSchema.safeParse(rawId);
  const body = PublishPlatformVersionRequestSchema.safeParse(rawBody);
  const headerVersion = parseIfMatch(ifMatch);
  if (
    !id.success ||
    !body.success ||
    headerVersion === null ||
    body.data.version !== headerVersion
  ) {
    return {
      issues: [
        ...(id.success ? [] : id.error.issues),
        ...(body.success ? [] : body.error.issues),
        ...(headerVersion === null || (body.success && body.data.version !== headerVersion)
          ? [headerIssue()]
          : []),
      ],
      success: false,
    };
  }
  return { id: id.data, success: true, version: headerVersion };
}

function parseIfMatch(value: string | string[] | undefined): number | null {
  if (Array.isArray(value) || typeof value !== 'string') return null;
  const match = /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/u.exec(value.trim());
  const version = Number(match?.[1] ?? match?.[2]);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

function headerIssue() {
  return { code: 'custom', path: ['headers', 'if-match'] };
}

function requireActor(request: FastifyRequest): string {
  const policy = getPolicyContext(request);
  if (!policy) throw new Error('PolicyGuard did not attach a PolicyContext');
  return policy.userId;
}

function auditContext(request: FastifyRequest) {
  return { ...(request.ip ? { ip: request.ip } : {}), requestId: request.id };
}

async function sendPage(
  reply: FastifyReply,
  requestId: string,
  page: { readonly items: readonly unknown[]; readonly nextCursor: string | null },
) {
  await reply.status(HttpStatus.OK).send({
    data: { items: page.items, next_cursor: page.nextCursor },
    meta: { request_id: requestId },
  });
}

async function sendView(
  reply: FastifyReply,
  requestId: string,
  view: { readonly version: number },
) {
  await reply
    .header('ETag', `"${view.version}"`)
    .status(HttpStatus.OK)
    .send({ data: view, meta: { request_id: requestId } });
}

async function sendPlatformConfigError(reply: FastifyReply, requestId: string, error: unknown) {
  if (error instanceof PlatformConfigNotFoundError)
    return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
  if (error instanceof PlatformConfigConflictError)
    return sendError(reply, requestId, 'VERSION_CONFLICT');
  if (error instanceof IdempotencyConflictError)
    return sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
  if (error instanceof PlatformConfigVersionError)
    return sendError(reply, requestId, 'VERSION_CONFLICT');
  if (error instanceof PlatformConfigStateError || error instanceof IdempotencyProcessingError)
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
  if (
    error instanceof PlatformConfigValidationError ||
    error instanceof IdempotencyKeyValidationError
  )
    return sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
  throw error;
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

async function sendError(reply: FastifyReply, requestId: string, code: PlatformConfigErrorCode) {
  const definition = ERROR_DEFINITIONS[code];
  await reply.status(definition.httpStatus).send({
    error: { code, message: definition.message, request_id: requestId },
  });
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
