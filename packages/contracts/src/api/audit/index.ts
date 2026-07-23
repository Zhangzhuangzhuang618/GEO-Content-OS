import type { PermissionCode, PolicyCode } from '../../permissions/index.js';
import type { z } from 'zod';

import { buildAuditOpenApiDocument } from './openapi.js';
import { AuditEventPageResponseSchema, AuditQuerySchema } from './schemas.js';

export * from './openapi.js';
export * from './schemas.js';

export interface AuditApiContract {
  readonly bodySchema: null;
  readonly idempotency: '-';
  readonly key: 'audit.events.list';
  readonly method: 'GET';
  readonly path: '/audit-events';
  readonly permission: Extract<PermissionCode, 'audit.read'>;
  readonly policy: Extract<PolicyCode, 'tenant_owner'>;
  readonly querySchema: z.ZodType;
  readonly responseName: 'AuditEventPage';
  readonly responseSchema: z.ZodType;
  readonly successStatus: 200;
}

export const AUDIT_API_CONTRACT: AuditApiContract = Object.freeze({
  bodySchema: null,
  idempotency: '-',
  key: 'audit.events.list',
  method: 'GET',
  path: '/audit-events',
  permission: 'audit.read',
  policy: 'tenant_owner',
  querySchema: AuditQuerySchema,
  responseName: 'AuditEventPage',
  responseSchema: AuditEventPageResponseSchema,
  successStatus: 200,
});

export const AUDIT_OPENAPI_DOCUMENT = buildAuditOpenApiDocument();
