import { z } from 'zod';

import type { PermissionCode, PolicyCode } from '../../permissions/index.js';
import {
  BrandProfileIdSchema,
  BrandProfilePageSchema,
  BrandProfileQuerySchema,
  BrandProfileResponseSchema,
  CreateBrandProfileRequestSchema,
  PublishVersionRequestSchema,
} from '../brand-profiles.js';
import { ReasonRequestSchema } from '../common.js';
import {
  CreateKeywordSetRequestSchema,
  KeywordListResponseSchema,
  KeywordSetIdSchema,
  KeywordSetResponseSchema,
  UpsertKeywordsRequestSchema,
} from '../keywords.js';
import {
  AdoptTopicRequestSchema,
  BriefResponseSchema,
  GenerationRunResponseSchema,
  TopicCandidateIdSchema,
  TopicCandidatePageSchema,
  TopicCandidateQuerySchema,
  TopicPlanRequestSchema,
} from '../topics.js';

export type StrategyApiMethod = 'GET' | 'POST';
export type StrategyIdempotency = '-' | 'key+body_hash' | 'resource+version';

export interface StrategyApiContract {
  readonly bodySchema: z.ZodType | null;
  readonly idempotency: StrategyIdempotency;
  readonly key: string;
  readonly method: StrategyApiMethod;
  readonly paramsSchema: z.ZodType | null;
  readonly path: string;
  readonly permission: Extract<PermissionCode, 'strategy.read' | 'strategy.manage'>;
  readonly policy: Extract<PolicyCode, 'tenant_member' | 'strategy_editor_or_admin'>;
  readonly querySchema: z.ZodType | null;
  readonly requestName: string;
  readonly responseName: string;
  readonly responseSchema: z.ZodType;
  readonly successStatus: 200 | 201 | 202;
}

const BrandProfileParamsSchema = z.object({ id: BrandProfileIdSchema }).strict();
const KeywordSetParamsSchema = z.object({ id: KeywordSetIdSchema }).strict();
const TopicCandidateParamsSchema = z.object({ id: TopicCandidateIdSchema }).strict();

const contracts = [
  {
    bodySchema: CreateBrandProfileRequestSchema,
    idempotency: 'key+body_hash',
    key: 'brand-profile.create',
    method: 'POST',
    paramsSchema: null,
    path: '/brand-profiles',
    permission: 'strategy.manage',
    policy: 'strategy_editor_or_admin',
    querySchema: null,
    requestName: 'CreateBrandProfileRequest',
    responseName: 'BrandProfileView',
    responseSchema: BrandProfileResponseSchema,
    successStatus: 201,
  },
  {
    bodySchema: null,
    idempotency: '-',
    key: 'brand-profile.list',
    method: 'GET',
    paramsSchema: null,
    path: '/brand-profiles',
    permission: 'strategy.read',
    policy: 'tenant_member',
    querySchema: BrandProfileQuerySchema,
    requestName: 'BrandProfileQuery',
    responseName: 'BrandProfilePage',
    responseSchema: BrandProfilePageSchema,
    successStatus: 200,
  },
  {
    bodySchema: null,
    idempotency: '-',
    key: 'brand-profile.get',
    method: 'GET',
    paramsSchema: BrandProfileParamsSchema,
    path: '/brand-profiles/{id}',
    permission: 'strategy.read',
    policy: 'tenant_member',
    querySchema: null,
    requestName: '-',
    responseName: 'BrandProfileView',
    responseSchema: BrandProfileResponseSchema,
    successStatus: 200,
  },
  {
    bodySchema: PublishVersionRequestSchema,
    idempotency: 'resource+version',
    key: 'brand-profile.publish',
    method: 'POST',
    paramsSchema: BrandProfileParamsSchema,
    path: '/brand-profiles/{id}/publish',
    permission: 'strategy.manage',
    policy: 'strategy_editor_or_admin',
    querySchema: null,
    requestName: 'PublishVersionRequest',
    responseName: 'BrandProfileView',
    responseSchema: BrandProfileResponseSchema,
    successStatus: 200,
  },
  {
    bodySchema: ReasonRequestSchema,
    idempotency: 'resource+version',
    key: 'brand-profile.retire',
    method: 'POST',
    paramsSchema: BrandProfileParamsSchema,
    path: '/brand-profiles/{id}/retire',
    permission: 'strategy.manage',
    policy: 'strategy_editor_or_admin',
    querySchema: null,
    requestName: 'ReasonRequest',
    responseName: 'BrandProfileView',
    responseSchema: BrandProfileResponseSchema,
    successStatus: 200,
  },
  {
    bodySchema: CreateKeywordSetRequestSchema,
    idempotency: 'key+body_hash',
    key: 'keyword-set.create',
    method: 'POST',
    paramsSchema: null,
    path: '/keyword-sets',
    permission: 'strategy.manage',
    policy: 'strategy_editor_or_admin',
    querySchema: null,
    requestName: 'CreateKeywordSetRequest',
    responseName: 'KeywordSetView',
    responseSchema: KeywordSetResponseSchema,
    successStatus: 201,
  },
  {
    bodySchema: UpsertKeywordsRequestSchema,
    idempotency: 'key+body_hash',
    key: 'keyword-set.upsert-keywords',
    method: 'POST',
    paramsSchema: KeywordSetParamsSchema,
    path: '/keyword-sets/{id}/keywords',
    permission: 'strategy.manage',
    policy: 'strategy_editor_or_admin',
    querySchema: null,
    requestName: 'UpsertKeywordsRequest',
    responseName: 'Keyword[]',
    responseSchema: KeywordListResponseSchema,
    successStatus: 200,
  },
  {
    bodySchema: TopicPlanRequestSchema,
    idempotency: 'key+body_hash',
    key: 'topic-plan.generate',
    method: 'POST',
    paramsSchema: null,
    path: '/topic-plans/generate',
    permission: 'strategy.manage',
    policy: 'strategy_editor_or_admin',
    querySchema: null,
    requestName: 'TopicPlanRequest',
    responseName: 'GenerationRunView',
    responseSchema: GenerationRunResponseSchema,
    successStatus: 202,
  },
  {
    bodySchema: null,
    idempotency: '-',
    key: 'topic-candidate.list',
    method: 'GET',
    paramsSchema: null,
    path: '/topic-candidates',
    permission: 'strategy.read',
    policy: 'tenant_member',
    querySchema: TopicCandidateQuerySchema,
    requestName: 'TopicCandidateQuery',
    responseName: 'TopicCandidatePage',
    responseSchema: TopicCandidatePageSchema,
    successStatus: 200,
  },
  {
    bodySchema: AdoptTopicRequestSchema,
    idempotency: 'resource+version',
    key: 'topic-candidate.adopt',
    method: 'POST',
    paramsSchema: TopicCandidateParamsSchema,
    path: '/topic-candidates/{id}/adopt',
    permission: 'strategy.manage',
    policy: 'strategy_editor_or_admin',
    querySchema: null,
    requestName: 'AdoptTopicRequest',
    responseName: 'BriefView',
    responseSchema: BriefResponseSchema,
    successStatus: 200,
  },
] as const satisfies readonly StrategyApiContract[];

export const STRATEGY_API_CONTRACTS = Object.freeze(
  contracts.map((contract) => Object.freeze(contract)),
) as readonly (typeof contracts)[number][];
export type StrategyApiContractKey = (typeof STRATEGY_API_CONTRACTS)[number]['key'];

export function findStrategyApiContract(key: StrategyApiContractKey): StrategyApiContract {
  const contract = STRATEGY_API_CONTRACTS.find((candidate) => candidate.key === key);
  if (!contract) throw new Error(`Unknown strategy API contract: ${key}`);
  return contract;
}
