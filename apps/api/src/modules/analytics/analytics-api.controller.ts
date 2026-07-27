import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import {
  AiVisibilityQuerySetCreateSchema,
  AiVisibilityQuerySetListQuerySchema,
  AiVisibilityRunCreateSchema,
  AiVisibilityRunDetailQuerySchema,
  AiVisibilityRunListQuerySchema,
  AiVisibilityRunParamsSchema,
  AnalyticsExportQuerySchema,
  AnalyticsQuerySchema,
  ContentAnalyticsQuerySchema,
  CostBudgetQuerySchema,
  CostQuerySchema,
  CostReconciliationRequestSchema,
  ERROR_DEFINITIONS,
  ImportJobParamsSchema,
  ManualMetricsRequestSchema,
  RollbackImportRequestSchema,
  VisibilityImportRequestSchema,
  VisibilityObservationRequestSchema,
  VisibilityTrendQuerySchema,
} from '@geo-content-os/contracts';
import {
  AiVisibilityService,
  AiVisibilityStateError,
  AiVisibilityValidationError,
} from './ai-visibility/index.js';
import {
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
  Body,
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
import {
  CostQueryService,
  CostQueryStateError,
  CostQueryValidationError,
} from '../billing/costs/index.js';
import { getPolicyContext, PolicyGuard, RequirePermissions } from '../identity/rbac/index.js';
import {
  AnalyticsQueryService,
  AnalyticsQueryStateError,
  AnalyticsQueryValidationError,
} from './queries/index.js';
import {
  MetricsImportService,
  MetricsImportStateError,
  MetricsImportValidationError,
} from './imports/index.js';
import {
  VisibilityService,
  VisibilityStateError,
  VisibilityValidationError,
} from './visibility/index.js';
import {
  AnalyticsApiAccessError,
  AnalyticsApiStateError,
  AnalyticsApiValidationError,
} from './analytics-api.errors.js';
import { AnalyticsApiService } from './analytics-api.service.js';
import type { AnalyticsApiScope } from './analytics-api.types.js';
import { ANALYTICS_STORAGE } from './analytics.tokens.js';
import { parseMetricsImportUpload } from './metrics-import-upload.js';

type AnalyticsErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'PERMISSION_DENIED'
  | 'RESOURCE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STATE_TRANSITION_INVALID';

@Controller()
@UseGuards(PolicyGuard)
export class AnalyticsApiController {
  public constructor(
    @Inject(AnalyticsQueryService) private readonly analytics: AnalyticsQueryService,
    @Inject(CostQueryService) private readonly costs: CostQueryService,
    @Inject(MetricsImportService) private readonly metrics: MetricsImportService,
    @Inject(VisibilityService) private readonly visibility: VisibilityService,
    @Inject(AiVisibilityService) private readonly aiVisibility: AiVisibilityService,
    @Inject(AnalyticsApiService) private readonly api: AnalyticsApiService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(ANALYTICS_STORAGE) private readonly storage: ObjectStorageAdapter,
  ) {}

  @Get('analytics/overview')
  @RequirePermissions('analytics.read')
  public async overview(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const query = AnalyticsQuerySchema.safeParse(raw);
    if (!query.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      return sendData(
        reply,
        request.id,
        await this.analytics.overview(
          { tenantId: scope.tenantId, userId: scope.userId, workspaceId: query.data.workspace_id },
          toAnalyticsFilter(query.data),
        ),
      );
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Get('analytics/platforms')
  @RequirePermissions('analytics.read')
  public async platforms(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const query = AnalyticsQuerySchema.safeParse(raw);
    if (!query.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      return sendData(
        reply,
        request.id,
        await this.analytics.platforms(
          { tenantId: scope.tenantId, userId: scope.userId, workspaceId: query.data.workspace_id },
          toAnalyticsFilter(query.data),
        ),
      );
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Get('analytics/contents')
  @RequirePermissions('analytics.read')
  public async contents(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const query = ContentAnalyticsQuerySchema.safeParse(raw);
    if (!query.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      return sendData(
        reply,
        request.id,
        await this.analytics.contents(
          { tenantId: scope.tenantId, userId: scope.userId, workspaceId: query.data.workspace_id },
          {
            ...toAnalyticsFilter(query.data),
            ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
            limit: query.data.limit,
          },
        ),
      );
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Get('analytics/costs')
  @RequirePermissions('cost.read')
  public async costBreakdown(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.costResponse(raw, request, reply);
  }

  @Get('analytics/costs/budget')
  @RequirePermissions('cost.read')
  public async costBudget(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = CostBudgetQuerySchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      return sendData(
        reply,
        request.id,
        await this.costs.budget(
          { tenantId: scope.tenantId, userId: scope.userId },
          { month: parsed.data.month, workspaceId: parsed.data.workspace_id },
        ),
      );
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Post('analytics/costs/reconcile')
  @RequirePermissions('cost.read')
  public async reconcileCosts(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = CostReconciliationRequestSchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      return sendData(
        reply,
        request.id,
        await this.costs.reconcileProviders(
          { tenantId: scope.tenantId, userId: scope.userId },
          toCostFilter(parsed.data),
          parsed.data.statement_lines.map((line) => ({
            billedCostCents: line.billed_cost_cents,
            currency: line.currency,
            provider: line.provider,
          })),
        ),
      );
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Get('usage/summary')
  @RequirePermissions('cost.read')
  public async usageSummary(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.costResponse(raw, request, reply);
  }

  @Post('metrics/import')
  @RequirePermissions('analytics.read')
  public async importCsv(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    try {
      const scope = requireScope(request);
      const upload = await parseMetricsImportUpload(request);
      const objectKey = `tenants/${scope.tenantId}/workspaces/${upload.workspaceId}/metric-imports/${upload.contentHash}.csv`;
      const stored = await this.storage.putObject({
        body: upload.body,
        contentHash: upload.contentHash,
        contentType: 'text/csv',
        key: objectKey,
      });
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, '/metrics/import', {
          content_hash: upload.contentHash,
          workspace_id: upload.workspaceId,
        }),
        async (transaction) => {
          const job = await this.metrics.queueCsv(
            transaction,
            { ...scope, workspaceId: upload.workspaceId },
            { contentHash: upload.contentHash, objectKey, objectUri: stored.uri },
          );
          const view = await this.api.getImportInTransaction(transaction, scope, job.id);
          return { body: apiResponse(view, request.id), statusCode: HttpStatus.CREATED };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Get('metrics/import-jobs/:id')
  @RequirePermissions('analytics.read')
  public async importJob(
    @Param() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const params = ImportJobParamsSchema.safeParse(raw);
    if (!params.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      return sendData(
        reply,
        request.id,
        await this.api.getImport(requireScope(request), params.data.id),
      );
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Post('metrics/import-jobs/:id/rollback')
  @RequirePermissions('analytics.read')
  public async rollbackImport(
    @Param() rawParams: unknown,
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const params = ImportJobParamsSchema.safeParse(rawParams);
    const body = RollbackImportRequestSchema.safeParse(rawBody);
    if (!params.success || !body.success) {
      return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    }
    try {
      const scope = requireScope(request);
      const route = `/metrics/import-jobs/${params.data.id}/rollback`;
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, route, body.data),
        async (transaction) => {
          const before = await this.api.getImportInTransaction(transaction, scope, params.data.id);
          await this.metrics.rollback(
            transaction,
            { ...scope, workspaceId: before.workspaceId },
            params.data.id,
            body.data.reason,
          );
          return {
            body: apiResponse(
              await this.api.getImportInTransaction(transaction, scope, params.data.id),
              request.id,
            ),
            statusCode: HttpStatus.OK,
          };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      if (error instanceof MetricsImportStateError) {
        return sendError(reply, request.id, 'STATE_TRANSITION_INVALID');
      }
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Post('metrics/manual')
  @RequirePermissions('analytics.read')
  public async manual(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = ManualMetricsRequestSchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, '/metrics/manual', parsed.data),
        async (transaction) => {
          const imported = await this.metrics.importRows(
            transaction,
            { ...scope, workspaceId: parsed.data.workspace_id },
            'manual',
            parsed.data.rows.map((row) => ({
              ...(row.account_id !== undefined ? { accountId: row.account_id } : {}),
              metricDate: row.metric_date,
              metricName: row.metric_name,
              metricValue: row.metric_value,
              platformCode: row.platform_code,
              ...(row.variant_id !== undefined ? { variantId: row.variant_id } : {}),
            })),
          );
          const records = await this.api.getMetricRecords(transaction, scope, imported.importJobId);
          return { body: apiResponse(records, request.id), statusCode: HttpStatus.CREATED };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Post('visibility-observations')
  @RequirePermissions('analytics.read')
  public async recordVisibility(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = VisibilityObservationRequestSchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      const screenshot = parsed.data.screenshot
        ? decodeScreenshot(parsed.data.screenshot)
        : undefined;
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, '/visibility-observations', parsed.data),
        async () => {
          const observation = await this.visibility.record(
            { ...scope, workspaceId: parsed.data.workspace_id },
            {
              ...(parsed.data.evidence_asset_id !== undefined
                ? { evidenceAssetId: parsed.data.evidence_asset_id }
                : {}),
              isCited: parsed.data.is_cited,
              ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
              observedAt: parsed.data.observed_at,
              platformCode: parsed.data.platform_code,
              queryText: parsed.data.query_text,
              ...(parsed.data.rank_position !== undefined
                ? { rankPosition: parsed.data.rank_position }
                : {}),
            },
            screenshot,
          );
          return { body: apiResponse(observation, request.id), statusCode: HttpStatus.CREATED };
        },
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Post('visibility-observations/import')
  @RequirePermissions('analytics.read')
  public async importVisibility(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = VisibilityImportRequestSchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, '/visibility-observations/import', parsed.data),
        async () => ({
          body: apiResponse(
            await this.visibility.importRows(
              { ...scope, workspaceId: parsed.data.workspace_id },
              parsed.data.rows.map((row) => ({
                ...(row.evidence_asset_id !== undefined
                  ? { evidenceAssetId: row.evidence_asset_id }
                  : {}),
                isCited: row.is_cited,
                ...(row.notes !== undefined ? { notes: row.notes } : {}),
                observedAt: row.observed_at,
                platformCode: row.platform_code,
                queryText: row.query_text,
                ...(row.rank_position !== undefined ? { rankPosition: row.rank_position } : {}),
              })),
            ),
            request.id,
          ),
          statusCode: HttpStatus.CREATED,
        }),
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Get('visibility-observations/trend')
  @RequirePermissions('analytics.read')
  public async visibilityTrend(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = VisibilityTrendQuerySchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      return sendData(
        reply,
        request.id,
        await this.visibility.trend(
          { ...scope, workspaceId: parsed.data.workspace_id },
          {
            from: parsed.data.from,
            ...(parsed.data.platform_code ? { platformCode: parsed.data.platform_code } : {}),
            ...(parsed.data.query_text ? { queryText: parsed.data.query_text } : {}),
            to: parsed.data.to,
          },
        ),
      );
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Post('ai-visibility/query-sets')
  @RequirePermissions('analytics.read')
  public async createAiVisibilityQuerySet(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = AiVisibilityQuerySetCreateSchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, '/ai-visibility/query-sets', parsed.data),
        async (transaction) => ({
          body: apiResponse(
            await this.aiVisibility.createQuerySet(transaction, scope, parsed.data),
            request.id,
          ),
          statusCode: HttpStatus.CREATED,
        }),
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Get('ai-visibility/query-sets')
  @RequirePermissions('analytics.read')
  public async listAiVisibilityQuerySets(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = AiVisibilityQuerySetListQuerySchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      return sendData(
        reply,
        request.id,
        await this.aiVisibility.listQuerySets(requireScope(request), parsed.data),
      );
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Post('ai-visibility/runs')
  @RequirePermissions('analytics.read')
  public async createAiVisibilityRuns(
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = AiVisibilityRunCreateSchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, '/ai-visibility/runs', parsed.data),
        async (transaction) => ({
          body: apiResponse(
            await this.aiVisibility.createRuns(transaction, scope, parsed.data),
            request.id,
          ),
          statusCode: HttpStatus.CREATED,
        }),
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Get('ai-visibility/runs')
  @RequirePermissions('analytics.read')
  public async listAiVisibilityRuns(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = AiVisibilityRunListQuerySchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      return sendData(
        reply,
        request.id,
        await this.aiVisibility.listRuns(requireScope(request), parsed.data),
      );
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Get('ai-visibility/runs/:id')
  @RequirePermissions('analytics.read')
  public async getAiVisibilityRun(
    @Param() rawParams: unknown,
    @Query() rawQuery: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const params = AiVisibilityRunParamsSchema.safeParse(rawParams);
    const query = AiVisibilityRunDetailQuerySchema.safeParse(rawQuery);
    if (!params.success || !query.success) {
      return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    }
    try {
      return sendData(
        reply,
        request.id,
        await this.aiVisibility.getRun(
          requireScope(request),
          query.data.workspace_id,
          params.data.id,
        ),
      );
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  @Get('analytics/export')
  @RequirePermissions('analytics.read')
  public async export(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = AnalyticsExportQuerySchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      const result = await this.idempotency.execute(
        idempotencyInput(request, scope, '/analytics/export', parsed.data),
        async (transaction) => ({
          body: apiResponse(
            await this.api.requestExport(transaction, scope, parsed.data),
            request.id,
          ),
          statusCode: HttpStatus.OK,
        }),
      );
      await reply.status(result.response.statusCode).send(result.response.body);
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }

  private async costResponse(raw: unknown, request: FastifyRequest, reply: FastifyReply) {
    const parsed = CostQuerySchema.safeParse(raw);
    if (!parsed.success) return sendError(reply, request.id, 'SCHEMA_VALIDATION_FAILED');
    try {
      const scope = requireScope(request);
      return sendData(
        reply,
        request.id,
        await this.costs.report(
          { tenantId: scope.tenantId, userId: scope.userId },
          toCostFilter(parsed.data),
        ),
      );
    } catch (error) {
      return sendAnalyticsError(reply, request.id, error);
    }
  }
}

function toCostFilter(query: {
  currency?: string | undefined;
  from: string;
  generation_run_id?: string | undefined;
  package_id?: string | undefined;
  project_id?: string | undefined;
  to: string;
  variant_id?: string | undefined;
  workspace_id?: string | undefined;
}) {
  return {
    ...(query.currency ? { currency: query.currency } : {}),
    from: query.from,
    ...(query.generation_run_id ? { generationRunId: query.generation_run_id } : {}),
    ...(query.package_id ? { packageId: query.package_id } : {}),
    ...(query.project_id ? { projectId: query.project_id } : {}),
    to: query.to,
    ...(query.variant_id ? { variantId: query.variant_id } : {}),
    ...(query.workspace_id ? { workspaceId: query.workspace_id } : {}),
  };
}

function requireScope(request: FastifyRequest): AnalyticsApiScope {
  const policy = getPolicyContext(request);
  if (!policy?.activeTenantId) throw new AnalyticsApiAccessError();
  return { requestId: request.id, tenantId: policy.activeTenantId, userId: policy.userId };
}

function toAnalyticsFilter(query: {
  from: string;
  platform_codes?: readonly string[] | undefined;
  project_id?: string | undefined;
  to: string;
}) {
  return {
    from: query.from,
    ...(query.platform_codes ? { platformCodes: query.platform_codes } : {}),
    ...(query.project_id ? { projectId: query.project_id } : {}),
    to: query.to,
  };
}

function idempotencyInput(
  request: FastifyRequest,
  scope: AnalyticsApiScope,
  route: string,
  body: unknown,
) {
  return {
    fingerprint: { body: toJson(body), method: request.method, path: route },
    idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
    scopeKey: buildIdempotencyScope({ actorId: scope.userId, method: request.method, route }),
    tenantId: scope.tenantId,
  };
}

function decodeScreenshot(value: {
  body_base64: string;
  mime_type: 'image/jpeg' | 'image/png' | 'image/webp';
}) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.body_base64))
    throw new AnalyticsApiValidationError();
  return {
    body: Uint8Array.from(Buffer.from(value.body_base64, 'base64')),
    mimeType: value.mime_type,
  };
}

async function sendData(reply: FastifyReply, requestId: string, data: unknown) {
  await reply.status(HttpStatus.OK).send(apiResponse(data, requestId));
}

function apiResponse(data: unknown, requestId: string): JsonValue {
  return toJson({ data, meta: { request_id: requestId } });
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(deepSnake(value))) as JsonValue;
}

function deepSnake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSnake);
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
      deepSnake(item),
    ]),
  );
}

async function sendAnalyticsError(reply: FastifyReply, requestId: string, error: unknown) {
  if (error instanceof AnalyticsApiAccessError)
    return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
  if (
    error instanceof AnalyticsApiStateError ||
    error instanceof AnalyticsQueryStateError ||
    error instanceof CostQueryStateError ||
    error instanceof MetricsImportStateError ||
    error instanceof AiVisibilityStateError ||
    error instanceof VisibilityStateError
  )
    return sendError(reply, requestId, 'RESOURCE_NOT_FOUND');
  if (
    error instanceof AnalyticsApiValidationError ||
    error instanceof AnalyticsQueryValidationError ||
    error instanceof CostQueryValidationError ||
    error instanceof MetricsImportValidationError ||
    error instanceof AiVisibilityValidationError ||
    error instanceof VisibilityValidationError ||
    error instanceof IdempotencyKeyValidationError
  )
    return sendError(reply, requestId, 'SCHEMA_VALIDATION_FAILED');
  if (error instanceof IdempotencyConflictError)
    return sendError(reply, requestId, 'IDEMPOTENCY_CONFLICT');
  if (error instanceof IdempotencyProcessingError)
    return sendError(reply, requestId, 'STATE_TRANSITION_INVALID');
  throw error;
}

async function sendError(reply: FastifyReply, requestId: string, code: AnalyticsErrorCode) {
  const definition = ERROR_DEFINITIONS[code];
  await reply
    .status(definition.httpStatus)
    .send({ error: { code, message: definition.message, request_id: requestId } });
}
