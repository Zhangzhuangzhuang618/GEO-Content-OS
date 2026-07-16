import type { z } from 'zod';

import { ANALYTICS_API_CONTRACTS } from './analytics/index.js';
import { AUDIT_API_CONTRACT } from './audit/index.js';
import { CONTENT_API_CONTRACTS } from './content/index.js';
import { CORE_API_CONTRACTS } from './core/index.js';
import { KNOWLEDGE_API_CONTRACTS } from './knowledge/index.js';
import { MEMBERSHIP_API_CONTRACTS } from './memberships/index.js';
import { PLATFORM_CONFIG_API_CONTRACTS } from './platform-config/index.js';
import { PLATFORM_TENANT_API_CONTRACTS } from './platform-tenants/index.js';
import { PUBLISHING_API_CONTRACTS } from './publishing/index.js';
import { REVIEW_API_CONTRACTS } from './review/index.js';
import { STRATEGY_API_CONTRACTS } from './strategy/index.js';
import { TENANT_LIFECYCLE_API_CONTRACTS } from './tenant-lifecycle/index.js';

export interface ApiContractCatalogItem {
  readonly bodySchema: z.ZodType | null;
  readonly idempotency: string;
  readonly key: string;
  readonly method: string;
  readonly paramsSchema: z.ZodType | null;
  readonly path: string;
  readonly permission: string;
  readonly policy: string;
  readonly querySchema: z.ZodType | null;
  readonly requestContentType: string;
  readonly responseName: string;
  readonly responseSchema: z.ZodType | null;
  readonly security: 'public' | 'session' | 'session_csrf';
  readonly successStatus: number;
}

type ContractLike = {
  readonly bodySchema?: z.ZodType | null;
  readonly idempotency: string;
  readonly key: string;
  readonly method: string;
  readonly paramsSchema?: z.ZodType | null;
  readonly path: string;
  readonly permission?: string;
  readonly permissions?: readonly string[];
  readonly policy: string;
  readonly querySchema?: z.ZodType | null;
  readonly requestContentType?: string;
  readonly responseName: string;
  readonly responseSchema?: z.ZodType | null;
  readonly security?: 'public' | 'session' | 'session_csrf';
  readonly successStatus: number;
};

const sourceContracts: readonly ContractLike[] = [
  ...CORE_API_CONTRACTS,
  ...MEMBERSHIP_API_CONTRACTS,
  ...PLATFORM_TENANT_API_CONTRACTS,
  ...PLATFORM_CONFIG_API_CONTRACTS,
  ...STRATEGY_API_CONTRACTS,
  ...KNOWLEDGE_API_CONTRACTS,
  ...CONTENT_API_CONTRACTS,
  ...REVIEW_API_CONTRACTS,
  ...PUBLISHING_API_CONTRACTS,
  ...ANALYTICS_API_CONTRACTS,
  AUDIT_API_CONTRACT,
  ...TENANT_LIFECYCLE_API_CONTRACTS,
];

export const API_CONTRACTS: readonly ApiContractCatalogItem[] = Object.freeze(
  sourceContracts
    .map((contract) =>
      Object.freeze({
        bodySchema: contract.bodySchema ?? null,
        idempotency: contract.idempotency,
        key: contract.key,
        method: contract.method,
        paramsSchema: contract.paramsSchema ?? null,
        path: contract.path,
        permission: contract.permission ?? contract.permissions?.join('|') ?? contract.policy,
        policy: contract.policy,
        querySchema: contract.querySchema ?? null,
        requestContentType: contract.requestContentType ?? 'application/json',
        responseName: contract.responseName,
        responseSchema: contract.responseSchema ?? null,
        security: contract.security ?? (contract.method === 'GET' ? 'session' : 'session_csrf'),
        successStatus: contract.successStatus,
      }),
    )
    .sort((left, right) =>
      `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`),
    ),
);
