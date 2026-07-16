import type { PermissionCode, PolicyCode } from '../../permissions/index.js';
import type { z } from 'zod';

import { buildPlatformTenantOpenApiDocument } from './openapi.js';
import {
  CreateTenantRequestSchema,
  PlatformTenantIdSchema,
  PlatformTenantPageResponseSchema,
  PlatformTenantResponseSchema,
  SuspendTenantRequestSchema,
  TenantListQuerySchema,
} from './schemas.js';

export * from './openapi.js';
export * from './schemas.js';

export interface PlatformTenantApiContract {
  readonly bodySchema: z.ZodType | null;
  readonly idempotency: '-' | 'key+body_hash' | 'resource+version';
  readonly key: string;
  readonly method: 'GET' | 'POST';
  readonly paramsSchema: z.ZodType | null;
  readonly path: string;
  readonly permission: Extract<PermissionCode, 'platform.tenants.manage'>;
  readonly policy: Extract<PolicyCode, 'platform_admin'>;
  readonly querySchema: z.ZodType | null;
  readonly responseName: string;
  readonly responseSchema: z.ZodType;
  readonly successStatus: 200 | 201;
}

const contracts = [
  contract(
    'platform.tenants.create',
    'POST',
    '/platform/tenants',
    'key+body_hash',
    CreateTenantRequestSchema,
    null,
    PlatformTenantResponseSchema,
    'TenantView',
    201,
  ),
  contract(
    'platform.tenants.list',
    'GET',
    '/platform/tenants',
    '-',
    null,
    TenantListQuerySchema,
    PlatformTenantPageResponseSchema,
    'TenantPage',
  ),
  contract(
    'platform.tenants.suspend',
    'POST',
    '/platform/tenants/{id}/suspend',
    'resource+version',
    SuspendTenantRequestSchema,
    null,
    PlatformTenantResponseSchema,
    'TenantView',
    200,
    PlatformTenantIdSchema,
  ),
  contract(
    'platform.tenants.restore',
    'POST',
    '/platform/tenants/{id}/restore',
    'resource+version',
    null,
    null,
    PlatformTenantResponseSchema,
    'TenantView',
    200,
    PlatformTenantIdSchema,
  ),
] as const satisfies readonly PlatformTenantApiContract[];

export const PLATFORM_TENANT_API_CONTRACTS: readonly PlatformTenantApiContract[] =
  Object.freeze(contracts);
export type PlatformTenantApiContractKey = (typeof contracts)[number]['key'];
export const PLATFORM_TENANT_OPENAPI_DOCUMENT = buildPlatformTenantOpenApiDocument(contracts);

export function findPlatformTenantApiContract(
  key: PlatformTenantApiContractKey,
): PlatformTenantApiContract {
  const contract = contracts.find((candidate) => candidate.key === key);
  if (!contract) throw new Error(`Unknown platform tenant API contract: ${key}`);
  return contract;
}

function contract(
  key: string,
  method: PlatformTenantApiContract['method'],
  path: string,
  idempotency: PlatformTenantApiContract['idempotency'],
  bodySchema: z.ZodType | null,
  querySchema: z.ZodType | null,
  responseSchema: z.ZodType,
  responseName: string,
  successStatus: PlatformTenantApiContract['successStatus'] = 200,
  paramsSchema: z.ZodType | null = null,
): PlatformTenantApiContract {
  return {
    bodySchema,
    idempotency,
    key,
    method,
    paramsSchema,
    path,
    permission: 'platform.tenants.manage',
    policy: 'platform_admin',
    querySchema,
    responseName,
    responseSchema,
    successStatus,
  };
}
