import {
  BaijiahaoAutomationPolicyRequestSchema,
  CreatePlatformAccountRequestSchema,
  CreatePublishJobRequestSchema,
  DisablePlatformAccountRequestSchema,
  ERROR_DEFINITIONS,
  GeneratePublishMediaRequestSchema,
  LiejuBrowserLoginRequestSchema,
  PlatformAccountParamsSchema,
  PlatformAccountQuerySchema,
  OfficialSiteAutomationPolicyRequestSchema,
  OfficialSiteDailyBatchCancelRequestSchema,
  OfficialSiteDailyBatchRestartRequestSchema,
  PublishJobParamsSchema,
  PublishJobQuerySchema,
  ReconcilePublishJobRequestSchema,
  ReasonRequestSchema,
  RefreshAccountRequestSchema,
  ResolveUnknownPublishRequestSchema,
  RetryPublishRequestSchema,
  SohuBrowserLoginRequestSchema,
  UpdatePlatformAccountRequestSchema,
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
  Put,
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
import {
  BaijiahaoAutomationPolicyService,
  OfficialSiteAutomationPolicyService,
  PlatformAccountError,
  PlatformAccountService,
  SohuBrowserSessionService,
  LiejuBrowserSessionService,
} from '../accounts/index.js';
import { PublishJobError, PublishJobService } from '../jobs/index.js';
import { PublishingApiError } from './publishing-api.errors.js';
import { PublishingApiService, type PublishingApiScope } from './publishing-api.service.js';

type PublishingErrorCode =
  | 'ADAPTER_AUTH_EXPIRED'
  | 'ADAPTER_CAPABILITY_UNAVAILABLE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID'
  | 'VERSION_CONFLICT';

@Controller('platform-accounts')
@UseGuards(PolicyGuard)
export class PlatformAccountController {
  public constructor(
    @Inject(PlatformAccountService) private readonly accounts: PlatformAccountService,
    @Inject(OfficialSiteAutomationPolicyService)
    private readonly automation: OfficialSiteAutomationPolicyService,
    @Inject(BaijiahaoAutomationPolicyService)
    private readonly baijiahaoAutomation: BaijiahaoAutomationPolicyService,
    @Inject(SohuBrowserSessionService)
    private readonly sohuBrowser: SohuBrowserSessionService,
    @Inject(LiejuBrowserSessionService)
    private readonly liejuBrowser: LiejuBrowserSessionService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @RequirePermissions('publishing.manage')
  public async create(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = CreatePlatformAccountRequestSchema.safeParse(raw);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    const scope = requireScope(request);
    try {
      const result = await idempotent(
        this.idempotency,
        request,
        scope,
        '/platform-accounts',
        parsed.data as JsonValue,
        (transaction) =>
          this.accounts.createInTransaction(transaction, scope, parsed.data, audit(request)),
        HttpStatus.CREATED,
      );
      await sendVersioned(reply, result.response.statusCode, result.response.body);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Get()
  @RequirePermissions('publishing.manage')
  public async list(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountQuerySchema.safeParse(raw);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const data = await this.accounts.list(requireScope(request), {
        ...(parsed.data.platform_code ? { platformCode: parsed.data.platform_code } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      });
      await reply.status(HttpStatus.OK).send({ data, meta: { request_id: request.id } });
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Patch(':id')
  @RequirePermissions('publishing.manage')
  public async update(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedParams = PlatformAccountParamsSchema.safeParse(params);
    const parsedBody = UpdatePlatformAccountRequestSchema.safeParse(raw);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    try {
      const data = await this.accounts.update(
        requireScope(request),
        parsedParams.data.id,
        parsedBody.data,
        parseIfMatch(request.headers['if-match']),
        audit(request),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/refresh')
  @RequirePermissions('publishing.manage')
  public async refresh(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedParams = PlatformAccountParamsSchema.safeParse(params);
    const parsedBody = RefreshAccountRequestSchema.safeParse(raw);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    try {
      const data = await this.accounts.refresh(
        requireScope(request),
        parsedParams.data.id,
        parsedBody.data,
        parseIfMatch(request.headers['if-match']),
        audit(request),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/test')
  @RequirePermissions('publishing.manage')
  public async test(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const result = await this.accounts.test(
        requireScope(request),
        parsed.data.id,
        parseIfMatch(request.headers['if-match']),
        audit(request),
      );
      const data = {
        account_id: result.account.id,
        capabilities: result.account.capabilities,
        checked_at: result.checkedAt.toISOString(),
        publish_mode: result.account.publish_mode,
        status: result.account.status,
        version: result.account.version,
      };
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/disable')
  @RequirePermissions('publishing.manage')
  public async disable(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedParams = PlatformAccountParamsSchema.safeParse(params);
    const parsedBody = DisablePlatformAccountRequestSchema.safeParse(raw);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    try {
      const data = await this.accounts.disable(
        requireScope(request),
        parsedParams.data.id,
        parsedBody.data.reason,
        parseIfMatch(request.headers['if-match']),
        audit(request),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/restore')
  @RequirePermissions('publishing.manage')
  public async restore(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const data = await this.accounts.restore(
        requireScope(request),
        parsed.data.id,
        parseIfMatch(request.headers['if-match']),
        audit(request),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Delete(':id')
  @RequirePermissions('publishing.manage')
  public async remove(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const data = await this.accounts.remove(
        requireScope(request),
        parsed.data.id,
        parseIfMatch(request.headers['if-match']),
        audit(request),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Get(':id/official-site-automation')
  @RequirePermissions('publishing.manage')
  public async listOfficialSiteAutomation(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const data = await this.automation.list(requireScope(request), parsed.data.id);
      await reply.status(HttpStatus.OK).send({ data, meta: { request_id: request.id } });
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Put(':id/official-site-automation')
  @RequirePermissions('publishing.manage')
  public async updateOfficialSiteAutomation(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedParams = PlatformAccountParamsSchema.safeParse(params);
    const parsedBody = OfficialSiteAutomationPolicyRequestSchema.safeParse(raw);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    try {
      const data = await this.automation.update(
        requireScope(request),
        parsedParams.data.id,
        parsedBody.data,
        audit(request),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/official-site-automation/daily-batch/restart')
  @RequirePermissions('publishing.manage')
  public async restartOfficialSiteDailyBatch(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedParams = PlatformAccountParamsSchema.safeParse(params);
    const parsedBody = OfficialSiteDailyBatchRestartRequestSchema.safeParse(raw);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    const scope = requireScope(request);
    try {
      const route = `/platform-accounts/${parsedParams.data.id}/official-site-automation/daily-batch/restart`;
      const result = await idempotent(
        this.idempotency,
        request,
        scope,
        route,
        parsedBody.data as JsonValue,
        (transaction) =>
          this.automation.restartDailyBatchInTransaction(
            transaction,
            scope,
            parsedParams.data.id,
            parsedBody.data,
            audit(request),
          ),
        HttpStatus.CREATED,
      );
      await sendVersioned(reply, result.response.statusCode, result.response.body);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/official-site-automation/daily-batch/cancel')
  @RequirePermissions('publishing.manage')
  public async cancelOfficialSiteDailyBatch(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedParams = PlatformAccountParamsSchema.safeParse(params);
    const parsedBody = OfficialSiteDailyBatchCancelRequestSchema.safeParse(raw);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    const scope = requireScope(request);
    try {
      const route = `/platform-accounts/${parsedParams.data.id}/official-site-automation/daily-batch/cancel`;
      const result = await idempotent(
        this.idempotency,
        request,
        scope,
        route,
        parsedBody.data as JsonValue,
        (transaction) =>
          this.automation.cancelDailyBatchInTransaction(
            transaction,
            scope,
            parsedParams.data.id,
            parsedBody.data,
            audit(request),
          ),
        HttpStatus.OK,
      );
      await sendVersioned(reply, result.response.statusCode, result.response.body);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Get(':id/baijiahao-automation')
  @RequirePermissions('publishing.manage')
  public async listBaijiahaoAutomation(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const data = await this.baijiahaoAutomation.list(requireScope(request), parsed.data.id);
      await reply.status(HttpStatus.OK).send({ data, meta: { request_id: request.id } });
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Put(':id/baijiahao-automation')
  @RequirePermissions('publishing.manage')
  public async updateBaijiahaoAutomation(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedParams = PlatformAccountParamsSchema.safeParse(params);
    const parsedBody = BaijiahaoAutomationPolicyRequestSchema.safeParse(raw);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    try {
      const data = await this.baijiahaoAutomation.update(
        requireScope(request),
        parsedParams.data.id,
        parsedBody.data,
        audit(request),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Get(':id/baijiahao-browser-session')
  @RequirePermissions('publishing.manage')
  public async getBaijiahaoBrowserSession(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const data = await this.baijiahaoAutomation.sessionStatus(
        requireScope(request),
        parsed.data.id,
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/baijiahao-browser-session/login')
  @RequirePermissions('publishing.manage')
  public async startBaijiahaoBrowserLogin(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const data = await this.baijiahaoAutomation.startLogin(
        requireScope(request),
        parsed.data.id,
        parseIfMatch(request.headers['if-match']),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/baijiahao-browser-session/reauth')
  @RequirePermissions('publishing.manage')
  public async reauthenticateBaijiahaoBrowser(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const data = await this.baijiahaoAutomation.reauthenticate(
        requireScope(request),
        parsed.data.id,
        parseIfMatch(request.headers['if-match']),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Get(':id/sohu-browser-session')
  @RequirePermissions('publishing.manage')
  public async getSohuBrowserSession(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const data = await this.sohuBrowser.status(requireScope(request), parsed.data.id);
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/sohu-browser-session/login')
  @RequirePermissions('publishing.manage')
  public async startSohuBrowserLogin(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    const parsedBody = SohuBrowserLoginRequestSchema.safeParse(raw);
    if (!parsed.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsed, parsedBody));
    }
    try {
      const data = await this.sohuBrowser.login(
        requireScope(request),
        parsed.data.id,
        parsedBody.data,
        parseIfMatch(request.headers['if-match']),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/sohu-browser-session/reauth')
  @RequirePermissions('publishing.manage')
  public async reauthenticateSohuBrowser(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    const parsedBody = SohuBrowserLoginRequestSchema.safeParse(raw);
    if (!parsed.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsed, parsedBody));
    }
    try {
      const data = await this.sohuBrowser.reauthenticate(
        requireScope(request),
        parsed.data.id,
        parsedBody.data,
        parseIfMatch(request.headers['if-match']),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Get(':id/lieju-browser-session')
  @RequirePermissions('publishing.manage')
  public async getLiejuBrowserSession(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const data = await this.liejuBrowser.status(requireScope(request), parsed.data.id);
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/lieju-browser-session/login')
  @RequirePermissions('publishing.manage')
  public async startLiejuBrowserLogin(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    const parsedBody = LiejuBrowserLoginRequestSchema.safeParse(raw);
    if (!parsed.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsed, parsedBody));
    }
    try {
      const data = await this.liejuBrowser.login(
        requireScope(request),
        parsed.data.id,
        parsedBody.data,
        parseIfMatch(request.headers['if-match']),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/lieju-browser-session/reauth')
  @RequirePermissions('publishing.manage')
  public async reauthenticateLiejuBrowser(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PlatformAccountParamsSchema.safeParse(params);
    const parsedBody = LiejuBrowserLoginRequestSchema.safeParse(raw);
    if (!parsed.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsed, parsedBody));
    }
    try {
      const data = await this.liejuBrowser.reauthenticate(
        requireScope(request),
        parsed.data.id,
        parsedBody.data,
        parseIfMatch(request.headers['if-match']),
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }
}

@Controller('publish-jobs')
@UseGuards(PolicyGuard)
export class PublishJobController {
  public constructor(
    @Inject(PublishingApiService) private readonly api: PublishingApiService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(PublishJobService) private readonly jobs: PublishJobService,
  ) {}

  @Post()
  @RequirePermissions('publishing.manage')
  public async create(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = CreatePublishJobRequestSchema.safeParse(raw);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    const scope = requireScope(request);
    try {
      const key = parseIdempotencyKey(request.headers['idempotency-key']);
      const result = await idempotent(
        this.idempotency,
        request,
        scope,
        '/publish-jobs',
        parsed.data as JsonValue,
        (transaction) =>
          this.jobs.createInTransaction(
            transaction,
            publishScope(scope, request),
            parsed.data,
            key,
          ),
        HttpStatus.CREATED,
        key,
      );
      await sendVersioned(reply, result.response.statusCode, result.response.body);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Get()
  @RequirePermissions('publishing.manage')
  public async list(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PublishJobQuerySchema.safeParse(raw);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const page = await this.api.listJobs(requireScope(request), parsed.data);
      await reply.status(HttpStatus.OK).send({
        data: page.items,
        meta: { next_cursor: page.nextCursor, request_id: request.id },
      });
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Get(':id')
  @RequirePermissions('publishing.manage')
  public async detail(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PublishJobParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      const data = await this.api.detail(requireScope(request), parsed.data.id);
      await sendData(reply, request.id, data, data.job.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/cancel')
  @RequirePermissions('publishing.manage')
  public async cancel(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedParams = PublishJobParamsSchema.safeParse(params);
    const parsedBody = ReasonRequestSchema.safeParse(raw);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    try {
      const data = await this.jobs.cancel(
        publishScope(requireScope(request), request),
        parsedParams.data.id,
        parseIfMatch(request.headers['if-match']),
        parsedBody.data.reason,
      );
      await sendData(reply, request.id, data, data.version);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/retry')
  @RequirePermissions('publishing.manage')
  public async retry(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedParams = PublishJobParamsSchema.safeParse(params);
    const parsedBody = RetryPublishRequestSchema.safeParse(raw);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    const scope = requireScope(request);
    try {
      const version = parseIfMatch(request.headers['if-match']);
      const route = `/publish-jobs/${parsedParams.data.id}/retry`;
      const result = await idempotent(
        this.idempotency,
        request,
        scope,
        route,
        parsedBody.data as JsonValue,
        (transaction) =>
          this.jobs.retryInTransaction(
            transaction,
            publishScope(scope, request),
            parsedParams.data.id,
            version,
            parsedBody.data,
          ),
        HttpStatus.OK,
        undefined,
        version,
      );
      await sendVersioned(reply, result.response.statusCode, result.response.body);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/resolve-unknown')
  @RequirePermissions('publishing.manage')
  public async resolveUnknown(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedParams = PublishJobParamsSchema.safeParse(params);
    const parsedBody = ResolveUnknownPublishRequestSchema.safeParse(raw);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    const scope = requireScope(request);
    try {
      const version = parseIfMatch(request.headers['if-match']);
      const route = `/publish-jobs/${parsedParams.data.id}/resolve-unknown`;
      const result = await idempotent(
        this.idempotency,
        request,
        scope,
        route,
        parsedBody.data as JsonValue,
        (transaction) =>
          this.jobs.resolveUnknownInTransaction(
            transaction,
            publishScope(scope, request),
            parsedParams.data.id,
            version,
            parsedBody.data,
          ),
        HttpStatus.OK,
        undefined,
        version,
      );
      await sendVersioned(reply, result.response.statusCode, result.response.body);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/reconcile')
  @RequirePermissions('publishing.manage')
  public async reconcile(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsedParams = PublishJobParamsSchema.safeParse(params);
    const parsedBody = ReconcilePublishJobRequestSchema.safeParse(raw);
    if (!parsedParams.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsedParams, parsedBody));
    }
    const scope = requireScope(request);
    try {
      const version = parseIfMatch(request.headers['if-match']);
      const route = `/publish-jobs/${parsedParams.data.id}/reconcile`;
      const result = await idempotent(
        this.idempotency,
        request,
        scope,
        route,
        parsedBody.data as JsonValue,
        (transaction) =>
          this.jobs.requestBaijiahaoReconciliationInTransaction(
            transaction,
            publishScope(scope, request),
            parsedParams.data.id,
            version,
          ),
        HttpStatus.OK,
        undefined,
        version,
      );
      await sendVersioned(reply, result.response.statusCode, result.response.body);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Post(':id/media')
  @RequirePermissions('publishing.manage')
  public async generateMedia(
    @Param() params: unknown,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PublishJobParamsSchema.safeParse(params);
    const parsedBody = GeneratePublishMediaRequestSchema.safeParse(raw);
    if (!parsed.success || !parsedBody.success) {
      return sendSchemaError(reply, request.id, issues(parsed, parsedBody));
    }
    const scope = requireScope(request);
    try {
      const version = parseIfMatch(request.headers['if-match']);
      const route = `/publish-jobs/${parsed.data.id}/media`;
      const result = await idempotent(
        this.idempotency,
        request,
        scope,
        route,
        {},
        (transaction) =>
          this.api.requestMedia(transaction, scope, parsed.data.id, version, request.id),
        HttpStatus.OK,
        undefined,
        version,
      );
      await sendVersioned(reply, result.response.statusCode, result.response.body);
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Get(':id/attempts')
  @RequirePermissions('publishing.manage')
  public async attempts(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PublishJobParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      await reply.status(HttpStatus.OK).send({
        data: await this.api.attempts(requireScope(request), parsed.data.id),
        meta: { request_id: request.id },
      });
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }

  @Get(':id/export')
  @RequirePermissions('publishing.manage')
  public async export(
    @Param() params: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PublishJobParamsSchema.safeParse(params);
    if (!parsed.success) return sendSchemaError(reply, request.id, parsed.error.issues);
    try {
      await sendData(
        reply,
        request.id,
        await this.api.signedExport(requireScope(request), parsed.data.id),
      );
    } catch (error) {
      await sendPublishingError(reply, request.id, error);
    }
  }
}

function idempotent<T>(
  service: IdempotencyService,
  request: FastifyRequest,
  scope: PublishingApiScope,
  route: string,
  body: JsonValue,
  operation: (transaction: TransactionSql) => Promise<T>,
  statusCode: number,
  knownKey?: string,
  version?: number,
) {
  return service.execute(
    {
      fingerprint: {
        body,
        method: request.method,
        path: route,
        ...(version === undefined ? {} : { query: { version } }),
      },
      idempotencyKey: knownKey ?? parseIdempotencyKey(request.headers['idempotency-key']),
      scopeKey: buildIdempotencyScope({ actorId: scope.userId, method: request.method, route }),
      tenantId: scope.tenantId,
    },
    async (transaction) => ({
      body: toJson({ data: await operation(transaction), meta: { request_id: request.id } }),
      statusCode,
    }),
  );
}

function requireScope(request: FastifyRequest): PublishingApiScope {
  const policy = getPolicyContext(request);
  if (!policy?.activeTenantId) throw new Error('PolicyGuard did not attach a tenant context');
  return { tenantId: policy.activeTenantId, userId: policy.userId };
}

function publishScope(scope: PublishingApiScope, request: FastifyRequest) {
  return { ...scope, ...(request.ip ? { ip: request.ip } : {}), requestId: request.id };
}

function audit(request: FastifyRequest) {
  return { ...(request.ip ? { ip: request.ip } : {}), requestId: request.id };
}

function parseIfMatch(value: string | string[] | undefined): number {
  if (Array.isArray(value) || typeof value !== 'string') throw invalidVersion();
  const match = /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/u.exec(value.trim());
  const version = Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(version) || version < 1) throw invalidVersion();
  return version;
}

function invalidVersion(): PublishJobError {
  return new PublishJobError('PUBLISH_JOB_INPUT_INVALID', 'If-Match must be a positive version');
}

async function sendData(
  reply: FastifyReply,
  requestId: string,
  data: unknown,
  version?: number,
): Promise<void> {
  if (version !== undefined) reply.header('ETag', `"${version}"`);
  await reply.status(HttpStatus.OK).send({ data, meta: { request_id: requestId } });
}

async function sendVersioned(reply: FastifyReply, status: number, body: JsonValue): Promise<void> {
  const version = responseVersion(body);
  if (version) reply.header('ETag', `"${version}"`);
  await reply.status(status).send(body);
}

async function sendSchemaError(
  reply: FastifyReply,
  requestId: string,
  issuesValue: readonly { readonly code: string; readonly path: PropertyKey[] }[],
): Promise<void> {
  await sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED', { issues: issuesValue });
}

async function sendPublishingError(
  reply: FastifyReply,
  requestId: string,
  error: unknown,
): Promise<void> {
  if (error instanceof IdempotencyConflictError)
    return sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
  if (error instanceof IdempotencyKeyValidationError)
    return sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
  if (error instanceof IdempotencyProcessingError)
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
  if (error instanceof PublishingApiError) {
    if (error.code === 'PUBLISHING_NOT_FOUND') {
      return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    }
    if (error.code === 'PUBLISHING_INPUT_INVALID') {
      return sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
    }
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
  }
  if (error instanceof PlatformAccountError) {
    if (error.code === 'PLATFORM_ACCOUNT_NOT_FOUND')
      return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    if (error.code === 'PLATFORM_ACCOUNT_VERSION_CONFLICT')
      return sendError(reply, requestId, 'VERSION_CONFLICT');
    if (error.code === 'PLATFORM_ACCOUNT_CREDENTIAL_INVALID')
      return sendError(reply, requestId, 'ADAPTER_AUTH_EXPIRED');
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID', error.details);
  }
  if (error instanceof PublishJobError) {
    if (error.code === 'PUBLISH_JOB_NOT_FOUND')
      return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
    if (error.code === 'PUBLISH_JOB_VERSION_CONFLICT')
      return sendError(reply, requestId, 'VERSION_CONFLICT');
    if (error.code === 'PUBLISH_ACCOUNT_AUTH_EXPIRED')
      return sendError(reply, requestId, 'ADAPTER_AUTH_EXPIRED');
    if (error.code === 'PUBLISH_CAPABILITY_UNAVAILABLE')
      return sendError(reply, requestId, 'ADAPTER_CAPABILITY_UNAVAILABLE');
    return sendError(
      reply,
      requestId,
      error.code === 'PUBLISH_JOB_INPUT_INVALID'
        ? 'SCHEMA_VALIDATION_FAILED'
        : 'STATE_TRANSITION_INVALID',
    );
  }
  throw error;
}

async function sendError(
  reply: FastifyReply,
  requestId: string,
  code: PublishingErrorCode,
  details?: unknown,
): Promise<void> {
  const definition = ERROR_DEFINITIONS[code];
  await reply.status(definition.httpStatus).send({
    error: {
      code,
      ...(details === undefined ? {} : { details }),
      message: definition.message,
      request_id: requestId,
    },
  });
}

function issues(
  ...values: readonly {
    success: boolean;
    error?: { issues: readonly { code: string; path: PropertyKey[] }[] };
  }[]
) {
  return values.flatMap((value) => (value.success ? [] : (value.error?.issues ?? [])));
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function responseVersion(body: JsonValue): number | null {
  if (!isRecord(body)) return null;
  const data = body['data'];
  return isRecord(data) && typeof data['version'] === 'number' ? data['version'] : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
