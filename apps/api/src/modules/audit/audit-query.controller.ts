import { AuditQuerySchema, ERROR_DEFINITIONS } from '@geo-content-os/contracts';
import { Controller, Get, HttpStatus, Inject, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { getPolicyContext, PolicyGuard, RequirePermissions } from '../identity/rbac/index.js';
import { AuditQueryService, AuditQueryValidationError } from './audit-query.service.js';

@Controller()
@UseGuards(PolicyGuard)
export class AuditQueryController {
  public constructor(@Inject(AuditQueryService) private readonly auditQuery: AuditQueryService) {}

  @Get('audit-events')
  @RequirePermissions('audit.read')
  public async list(
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const query = AuditQuerySchema.safeParse(raw);
    if (!query.success) {
      await sendSchemaError(reply, request.id, query.error.issues);
      return;
    }
    try {
      const tenantId = requireTenant(request);
      const page = await this.auditQuery.list(tenantId, query.data);
      await reply.status(HttpStatus.OK).send({
        data: { items: page.items, next_cursor: page.nextCursor },
        meta: { request_id: request.id },
      });
    } catch (error) {
      if (error instanceof AuditQueryValidationError) {
        await sendSchemaError(reply, request.id, [{ code: 'custom', path: ['cursor'] }]);
        return;
      }
      throw error;
    }
  }
}

function requireTenant(request: FastifyRequest): string {
  const context = getPolicyContext(request);
  if (!context?.activeTenantId) throw new Error('PolicyGuard did not attach a tenant context');
  return context.activeTenantId;
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
