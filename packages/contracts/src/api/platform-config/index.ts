import type { PermissionCode, PolicyCode } from '../../permissions/index.js';
import type { z } from 'zod';

import { buildPlatformConfigOpenApiDocument } from './openapi.js';
import {
  CreatePromptVersionRequestSchema,
  CreateRuleVersionRequestSchema,
  PlatformConfigIdSchema,
  PromptVersionPageResponseSchema,
  PromptVersionQuerySchema,
  PromptVersionResponseSchema,
  PublishPlatformVersionRequestSchema,
  RetirePlatformVersionRequestSchema,
  RuleVersionPageResponseSchema,
  RuleVersionQuerySchema,
  RuleVersionResponseSchema,
} from './schemas.js';

export * from './openapi.js';
export * from './schemas.js';

export interface PlatformConfigApiContract {
  readonly bodySchema: z.ZodType | null;
  readonly idempotency: '-' | 'key+body_hash' | 'resource+version';
  readonly key: string;
  readonly method: 'GET' | 'POST';
  readonly paramsSchema: z.ZodType | null;
  readonly path: string;
  readonly permission: Extract<PermissionCode, 'platform.prompts.manage' | 'platform.rules.manage'>;
  readonly policy: Extract<PolicyCode, 'platform_operator'>;
  readonly querySchema: z.ZodType | null;
  readonly responseName: string;
  readonly responseSchema: z.ZodType;
  readonly successStatus: 200 | 201;
}

const contracts = [
  contract(
    'platform.prompt-versions.list',
    'GET',
    '/platform/prompt-versions',
    'platform.prompts.manage',
    '-',
    null,
    PromptVersionQuerySchema,
    PromptVersionPageResponseSchema,
    'PromptVersionPage',
  ),
  contract(
    'platform.prompt-versions.create',
    'POST',
    '/platform/prompt-versions',
    'platform.prompts.manage',
    'key+body_hash',
    CreatePromptVersionRequestSchema,
    null,
    PromptVersionResponseSchema,
    'PromptVersionView',
    201,
  ),
  contract(
    'platform.prompt-versions.publish',
    'POST',
    '/platform/prompt-versions/{id}/publish',
    'platform.prompts.manage',
    'resource+version',
    PublishPlatformVersionRequestSchema,
    null,
    PromptVersionResponseSchema,
    'PromptVersionView',
    200,
    PlatformConfigIdSchema,
  ),
  contract(
    'platform.prompt-versions.retire',
    'POST',
    '/platform/prompt-versions/{id}/retire',
    'platform.prompts.manage',
    'resource+version',
    RetirePlatformVersionRequestSchema,
    null,
    PromptVersionResponseSchema,
    'PromptVersionView',
    200,
    PlatformConfigIdSchema,
  ),
  contract(
    'platform.rule-versions.list',
    'GET',
    '/platform/rule-versions',
    'platform.rules.manage',
    '-',
    null,
    RuleVersionQuerySchema,
    RuleVersionPageResponseSchema,
    'RuleVersionPage',
  ),
  contract(
    'platform.rule-versions.create',
    'POST',
    '/platform/rule-versions',
    'platform.rules.manage',
    'key+body_hash',
    CreateRuleVersionRequestSchema,
    null,
    RuleVersionResponseSchema,
    'RuleVersionView',
    201,
  ),
  contract(
    'platform.rule-versions.publish',
    'POST',
    '/platform/rule-versions/{id}/publish',
    'platform.rules.manage',
    'resource+version',
    PublishPlatformVersionRequestSchema,
    null,
    RuleVersionResponseSchema,
    'RuleVersionView',
    200,
    PlatformConfigIdSchema,
  ),
  contract(
    'platform.rule-versions.retire',
    'POST',
    '/platform/rule-versions/{id}/retire',
    'platform.rules.manage',
    'resource+version',
    RetirePlatformVersionRequestSchema,
    null,
    RuleVersionResponseSchema,
    'RuleVersionView',
    200,
    PlatformConfigIdSchema,
  ),
] as const satisfies readonly PlatformConfigApiContract[];

export const PLATFORM_CONFIG_API_CONTRACTS: readonly PlatformConfigApiContract[] =
  Object.freeze(contracts);
export const PLATFORM_CONFIG_OPENAPI_DOCUMENT = buildPlatformConfigOpenApiDocument(contracts);

function contract(
  key: string,
  method: PlatformConfigApiContract['method'],
  path: string,
  permission: PlatformConfigApiContract['permission'],
  idempotency: PlatformConfigApiContract['idempotency'],
  bodySchema: z.ZodType | null,
  querySchema: z.ZodType | null,
  responseSchema: z.ZodType,
  responseName: string,
  successStatus: PlatformConfigApiContract['successStatus'] = 200,
  paramsSchema: z.ZodType | null = null,
): PlatformConfigApiContract {
  return {
    bodySchema,
    idempotency,
    key,
    method,
    paramsSchema,
    path,
    permission,
    policy: 'platform_operator',
    querySchema,
    responseName,
    responseSchema,
    successStatus,
  };
}
