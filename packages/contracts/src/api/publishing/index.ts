import type { PermissionCode, PolicyCode } from '../../permissions/index.js';
import type { z } from 'zod';

import { buildPublishingOpenApiDocument } from './openapi.js';
import {
  CreatePublishJobRequestSchema,
  PublishAttemptPageSchema,
  PublishJobDetailResponseSchema,
  PublishJobPageSchema,
  PublishJobParamsSchema,
  PublishJobQuerySchema,
  PublishJobResponseSchema,
  RetryPublishRequestSchema,
  SignedDownloadResponseSchema,
} from './job-schemas.js';
import {
  CapabilityResponseSchema,
  CreatePlatformAccountRequestSchema,
  DisablePlatformAccountRequestSchema,
  PlatformAccountPageSchema,
  PlatformAccountParamsSchema,
  PlatformAccountQuerySchema,
  PlatformAccountResponseSchema,
  RefreshAccountRequestSchema,
} from './schemas.js';
import { ReasonRequestSchema } from '../common.js';

export * from './job-schemas.js';
export * from './openapi.js';
export * from './schemas.js';

export interface PublishingApiContract {
  readonly bodySchema: z.ZodType | null;
  readonly idempotency: '-' | 'key+body_hash' | 'key+version' | 'resource+version';
  readonly key: string;
  readonly method: 'GET' | 'POST';
  readonly paramsSchema: z.ZodType | null;
  readonly path: string;
  readonly permission: Extract<PermissionCode, 'publishing.manage'>;
  readonly policy: Extract<PolicyCode, 'publisher_or_admin'>;
  readonly querySchema: z.ZodType | null;
  readonly requestName: string;
  readonly responseName: string;
  readonly responseSchema: z.ZodType;
  readonly successStatus: 200 | 201;
}

const contracts = [
  contract(
    'account.create',
    'POST',
    '/platform-accounts',
    'key+body_hash',
    CreatePlatformAccountRequestSchema,
    null,
    null,
    'CreatePlatformAccountRequest',
    'PlatformAccountView',
    PlatformAccountResponseSchema,
    201,
  ),
  contract(
    'account.list',
    'GET',
    '/platform-accounts',
    '-',
    null,
    PlatformAccountQuerySchema,
    null,
    'PlatformAccountQuery',
    'PlatformAccountPage',
    PlatformAccountPageSchema,
  ),
  contract(
    'account.refresh',
    'POST',
    '/platform-accounts/{id}/refresh',
    'resource+version',
    RefreshAccountRequestSchema,
    null,
    PlatformAccountParamsSchema,
    'RefreshAccountRequest',
    'PlatformAccountView',
    PlatformAccountResponseSchema,
  ),
  contract(
    'account.test',
    'POST',
    '/platform-accounts/{id}/test',
    'resource+version',
    null,
    null,
    PlatformAccountParamsSchema,
    '-',
    'CapabilityView',
    CapabilityResponseSchema,
  ),
  contract(
    'account.disable',
    'POST',
    '/platform-accounts/{id}/disable',
    'resource+version',
    DisablePlatformAccountRequestSchema,
    null,
    PlatformAccountParamsSchema,
    'ReasonRequest',
    'PlatformAccountView',
    PlatformAccountResponseSchema,
  ),
  contract(
    'job.create',
    'POST',
    '/publish-jobs',
    'key+body_hash',
    CreatePublishJobRequestSchema,
    null,
    null,
    'CreatePublishJobRequest',
    'PublishJobView',
    PublishJobResponseSchema,
    201,
  ),
  contract(
    'job.list',
    'GET',
    '/publish-jobs',
    '-',
    null,
    PublishJobQuerySchema,
    null,
    'PublishJobQuery',
    'PublishJobPage',
    PublishJobPageSchema,
  ),
  contract(
    'job.get',
    'GET',
    '/publish-jobs/{id}',
    '-',
    null,
    null,
    PublishJobParamsSchema,
    '-',
    'PublishJobDetail',
    PublishJobDetailResponseSchema,
  ),
  contract(
    'job.cancel',
    'POST',
    '/publish-jobs/{id}/cancel',
    'resource+version',
    ReasonRequestSchema,
    null,
    PublishJobParamsSchema,
    'ReasonRequest',
    'PublishJobView',
    PublishJobResponseSchema,
  ),
  contract(
    'job.retry',
    'POST',
    '/publish-jobs/{id}/retry',
    'key+version',
    RetryPublishRequestSchema,
    null,
    PublishJobParamsSchema,
    'RetryPublishRequest',
    'PublishJobView',
    PublishJobResponseSchema,
  ),
  contract(
    'job.attempts',
    'GET',
    '/publish-jobs/{id}/attempts',
    '-',
    null,
    null,
    PublishJobParamsSchema,
    '-',
    'PublishAttempt[]',
    PublishAttemptPageSchema,
  ),
  contract(
    'job.export',
    'GET',
    '/publish-jobs/{id}/export',
    '-',
    null,
    null,
    PublishJobParamsSchema,
    '-',
    'SignedDownloadView',
    SignedDownloadResponseSchema,
  ),
] as const satisfies readonly PublishingApiContract[];

export const PUBLISHING_API_CONTRACTS: readonly PublishingApiContract[] = Object.freeze(contracts);
export type PublishingApiContractKey = (typeof contracts)[number]['key'];
export const PUBLISHING_OPENAPI_DOCUMENT = buildPublishingOpenApiDocument(contracts);

export function findPublishingApiContract(key: PublishingApiContractKey): PublishingApiContract {
  const found = contracts.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Unknown Publishing API contract: ${key}`);
  return found;
}

function contract(
  key: string,
  method: PublishingApiContract['method'],
  path: string,
  idempotency: PublishingApiContract['idempotency'],
  bodySchema: z.ZodType | null,
  querySchema: z.ZodType | null,
  paramsSchema: z.ZodType | null,
  requestName: string,
  responseName: string,
  responseSchema: z.ZodType,
  successStatus: PublishingApiContract['successStatus'] = 200,
): PublishingApiContract {
  return {
    bodySchema,
    idempotency,
    key,
    method,
    paramsSchema,
    path,
    permission: 'publishing.manage',
    policy: 'publisher_or_admin',
    querySchema,
    requestName,
    responseName,
    responseSchema,
    successStatus,
  };
}
