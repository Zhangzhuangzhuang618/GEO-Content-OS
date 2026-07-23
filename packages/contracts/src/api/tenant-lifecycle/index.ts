import type { PermissionCode, PolicyCode } from '../../permissions/index.js';
import type { z } from 'zod';

import { buildTenantLifecycleOpenApiDocument } from './openapi.js';
import {
  TenantExportJobResponseSchema,
  TenantExportParamsSchema,
  TenantExportRequestSchema,
} from './schemas.js';

export * from './openapi.js';
export * from './schemas.js';

export interface TenantLifecycleApiContract {
  readonly bodySchema: z.ZodType | null;
  readonly idempotency: '-' | 'key+body_hash';
  readonly key: string;
  readonly method: 'GET' | 'POST';
  readonly paramsSchema: z.ZodType | null;
  readonly path: string;
  readonly permission: Extract<PermissionCode, 'audit.export'>;
  readonly policy: Extract<PolicyCode, 'tenant_owner'>;
  readonly responseName: string;
  readonly responseSchema: z.ZodType;
  readonly successStatus: 200 | 201;
}

const contracts = [
  {
    bodySchema: TenantExportRequestSchema,
    idempotency: 'key+body_hash',
    key: 'tenant-lifecycle.create-export',
    method: 'POST',
    paramsSchema: null,
    path: '/tenant-exports',
    permission: 'audit.export',
    policy: 'tenant_owner',
    responseName: 'TenantExportJobView',
    responseSchema: TenantExportJobResponseSchema,
    successStatus: 201,
  },
  {
    bodySchema: null,
    idempotency: '-',
    key: 'tenant-lifecycle.get-export',
    method: 'GET',
    paramsSchema: TenantExportParamsSchema,
    path: '/tenant-exports/{id}',
    permission: 'audit.export',
    policy: 'tenant_owner',
    responseName: 'TenantExportJobView',
    responseSchema: TenantExportJobResponseSchema,
    successStatus: 200,
  },
] as const satisfies readonly TenantLifecycleApiContract[];

export const TENANT_LIFECYCLE_API_CONTRACTS: readonly TenantLifecycleApiContract[] =
  Object.freeze(contracts);
export const TENANT_LIFECYCLE_OPENAPI_DOCUMENT = buildTenantLifecycleOpenApiDocument(contracts);
