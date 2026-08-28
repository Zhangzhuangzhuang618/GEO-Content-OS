import { z } from 'zod';

import type { PermissionCode, PolicyCode } from '../../permissions/index.js';
import { ReasonRequestSchema } from '../common.js';
import {
  BatchUrlPreviewRequestSchema,
  BatchUrlPreviewResponseSchema,
  FactIdSchema,
  FactPageSchema,
  FactQuerySchema,
  FactResponseSchema,
  IngestJobIdSchema,
  IngestJobResponseSchema,
  NoContentResponseSchema,
  ReindexRequestSchema,
  SourceCreateSchema,
  SourceDetailResponseSchema,
  SourceIdSchema,
  SourceListQuerySchema,
  SourcePageSchema,
  SourceScopeQuerySchema,
  SourceUploadResponseSchema,
  SourceResponseSchema,
  UpdateSourceValidityRequestSchema,
  VerifyFactRequestSchema,
} from './schemas.js';

export * from './schemas.js';

export type KnowledgeApiMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST';
export type KnowledgeIdempotency =
  '-' | 'key+content_hash' | 'resource+source_hash' | 'resource+version';

export interface KnowledgeApiContract {
  readonly bodySchema: z.ZodType | null;
  readonly idempotency: KnowledgeIdempotency;
  readonly key: string;
  readonly method: KnowledgeApiMethod;
  readonly paramsSchema: z.ZodType | null;
  readonly path: string;
  readonly permissions: readonly Extract<
    PermissionCode,
    'knowledge.read' | 'knowledge.sources.manage' | 'knowledge.facts.verify' | 'review.decide'
  >[];
  readonly policy: Extract<
    PolicyCode,
    'tenant_member' | 'strategy_or_content_editor_or_admin' | 'reviewer_or_admin'
  >;
  readonly querySchema: z.ZodType | null;
  readonly revision?: 'updated_at';
  readonly requestContentType?: 'application/json' | 'multipart/form-data';
  readonly requestName: string;
  readonly responseName: string;
  readonly responseSchema: z.ZodType;
  readonly successStatus: 200 | 201 | 202 | 204;
}

const SourceParamsSchema = z.object({ id: SourceIdSchema }).strict();
const IngestJobParamsSchema = z.object({ id: IngestJobIdSchema }).strict();
const FactParamsSchema = z.object({ id: FactIdSchema }).strict();

const contracts = [
  {
    key: 'source.create',
    method: 'POST',
    path: '/sources',
    policy: 'strategy_or_content_editor_or_admin',
    permissions: ['knowledge.sources.manage'],
    requestName: 'SourceCreate',
    requestContentType: 'multipart/form-data',
    responseName: 'SourceView + IngestJob',
    idempotency: 'key+content_hash',
    successStatus: 201,
    bodySchema: SourceCreateSchema,
    querySchema: null,
    paramsSchema: null,
    responseSchema: SourceUploadResponseSchema,
  },
  {
    key: 'source.batch-url.preview',
    method: 'POST',
    path: '/sources/batch-url-preview',
    policy: 'strategy_or_content_editor_or_admin',
    permissions: ['knowledge.sources.manage'],
    requestName: 'BatchUrlPreviewRequest',
    requestContentType: 'multipart/form-data',
    responseName: 'BatchUrlPreview',
    idempotency: '-',
    successStatus: 200,
    bodySchema: BatchUrlPreviewRequestSchema,
    querySchema: null,
    paramsSchema: null,
    responseSchema: BatchUrlPreviewResponseSchema,
  },
  {
    key: 'source.list',
    method: 'GET',
    path: '/sources',
    policy: 'tenant_member',
    permissions: ['knowledge.read'],
    requestName: 'SourceListQuery',
    responseName: 'SourcePage',
    idempotency: '-',
    successStatus: 200,
    bodySchema: null,
    querySchema: SourceListQuerySchema,
    paramsSchema: null,
    responseSchema: SourcePageSchema,
  },
  {
    key: 'source.get',
    method: 'GET',
    path: '/sources/{id}',
    policy: 'tenant_member',
    permissions: ['knowledge.read'],
    requestName: 'SourceScopeQuery',
    responseName: 'SourceDetailView',
    idempotency: '-',
    successStatus: 200,
    bodySchema: null,
    querySchema: SourceScopeQuerySchema,
    paramsSchema: SourceParamsSchema,
    responseSchema: SourceDetailResponseSchema,
  },
  {
    key: 'source.reindex',
    method: 'POST',
    path: '/sources/{id}/reindex',
    policy: 'strategy_or_content_editor_or_admin',
    permissions: ['knowledge.sources.manage'],
    requestName: 'ReindexRequest',
    responseName: 'IngestJobView',
    idempotency: 'resource+source_hash',
    successStatus: 202,
    bodySchema: ReindexRequestSchema,
    querySchema: null,
    paramsSchema: SourceParamsSchema,
    responseSchema: IngestJobResponseSchema,
  },
  {
    key: 'source.validity.update',
    method: 'PATCH',
    path: '/sources/{id}/validity',
    policy: 'strategy_or_content_editor_or_admin',
    permissions: ['knowledge.sources.manage'],
    requestName: 'UpdateSourceValidityRequest',
    responseName: 'SourceView',
    revision: 'updated_at',
    idempotency: 'resource+version',
    successStatus: 200,
    bodySchema: UpdateSourceValidityRequestSchema,
    querySchema: null,
    paramsSchema: SourceParamsSchema,
    responseSchema: SourceResponseSchema,
  },
  {
    key: 'source.delete',
    method: 'DELETE',
    path: '/sources/{id}',
    policy: 'strategy_or_content_editor_or_admin',
    permissions: ['knowledge.sources.manage'],
    requestName: 'ReasonRequest',
    responseName: '-',
    revision: 'updated_at',
    idempotency: 'resource+version',
    successStatus: 204,
    bodySchema: ReasonRequestSchema,
    querySchema: null,
    paramsSchema: SourceParamsSchema,
    responseSchema: NoContentResponseSchema,
  },
  {
    key: 'ingest-job.get',
    method: 'GET',
    path: '/ingest-jobs/{id}',
    policy: 'tenant_member',
    permissions: ['knowledge.read'],
    requestName: 'SourceScopeQuery',
    responseName: 'IngestJobView',
    idempotency: '-',
    successStatus: 200,
    bodySchema: null,
    querySchema: SourceScopeQuerySchema,
    paramsSchema: IngestJobParamsSchema,
    responseSchema: IngestJobResponseSchema,
  },
  {
    key: 'fact.list',
    method: 'GET',
    path: '/facts',
    policy: 'tenant_member',
    permissions: ['knowledge.read'],
    requestName: 'FactQuery',
    responseName: 'FactPage',
    idempotency: '-',
    successStatus: 200,
    bodySchema: null,
    querySchema: FactQuerySchema,
    paramsSchema: null,
    responseSchema: FactPageSchema,
  },
  {
    key: 'fact.verify',
    method: 'POST',
    path: '/facts/{id}/verify',
    policy: 'reviewer_or_admin',
    permissions: ['knowledge.facts.verify', 'review.decide'],
    requestName: 'VerifyFactRequest',
    responseName: 'FactView',
    idempotency: 'resource+version',
    successStatus: 200,
    bodySchema: VerifyFactRequestSchema,
    querySchema: null,
    paramsSchema: FactParamsSchema,
    responseSchema: FactResponseSchema,
  },
] as const satisfies readonly KnowledgeApiContract[];

export const KNOWLEDGE_API_CONTRACTS = Object.freeze(
  contracts.map((contract) =>
    Object.freeze({ ...contract, permissions: Object.freeze([...contract.permissions]) }),
  ),
);

export type KnowledgeApiContractKey = (typeof contracts)[number]['key'];

export function findKnowledgeApiContract(key: KnowledgeApiContractKey): KnowledgeApiContract {
  const contract = KNOWLEDGE_API_CONTRACTS.find((candidate) => candidate.key === key);
  if (!contract) throw new Error(`Unknown knowledge API contract: ${key}`);
  return contract;
}
