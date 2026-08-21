import { describe, expect, it } from 'vitest';

import { TENANT_ROLE_CODES } from '../../roles.js';
import { roleHasPermission } from '../../permissions/index.js';
import { BrandProfilePageSchema, BrandProfileResponseSchema } from '../brand-profiles.js';
import {
  BatchKeywordOperationResponseSchema,
  KeywordListResponseSchema,
  ProjectKeywordPlatformScopeSyncResponseSchema,
  KeywordSetDetailResponseSchema,
  KeywordSetPageSchema,
  KeywordSetResponseSchema,
} from '../keywords.js';
import {
  BriefResponseSchema,
  GenerationRunResponseSchema,
  TopicCandidatePageSchema,
} from '../topics.js';
import { STRATEGY_API_CONTRACTS } from './index.js';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const timestamp = '2026-07-14T03:00:00.000Z';
const requestId = '01J00000000000000000000000';

describe('frozen strategy API contract', () => {
  it('contains the eighteen approved brand, keyword, import, and topic endpoints', () => {
    expect(
      STRATEGY_API_CONTRACTS.map((contract) => ({
        idempotency: contract.idempotency,
        method: contract.method,
        path: contract.path,
        permission: contract.permission,
        request: contract.requestName,
        response: contract.responseName,
        status: contract.successStatus,
      })),
    ).toEqual([
      endpoint(
        'POST',
        '/brand-profiles',
        'strategy.manage',
        'CreateBrandProfileRequest',
        'BrandProfileView',
        'key+body_hash',
        201,
      ),
      endpoint(
        'GET',
        '/brand-profiles',
        'strategy.read',
        'BrandProfileQuery',
        'BrandProfilePage',
        '-',
        200,
      ),
      endpoint('GET', '/brand-profiles/{id}', 'strategy.read', '-', 'BrandProfileView', '-', 200),
      endpoint(
        'POST',
        '/brand-profiles/{id}/publish',
        'strategy.manage',
        'PublishVersionRequest',
        'BrandProfileView',
        'resource+version',
        200,
      ),
      endpoint(
        'POST',
        '/brand-profiles/{id}/retire',
        'strategy.manage',
        'ReasonRequest',
        'BrandProfileView',
        'resource+version',
        200,
      ),
      endpoint(
        'POST',
        '/keyword-sets',
        'strategy.manage',
        'CreateKeywordSetRequest',
        'KeywordSetView',
        'key+body_hash',
        201,
      ),
      endpoint(
        'GET',
        '/keyword-sets',
        'strategy.read',
        'KeywordSetQuery',
        'KeywordSetPage',
        '-',
        200,
      ),
      endpoint('GET', '/keyword-sets/{id}', 'strategy.read', '-', 'KeywordSetDetail', '-', 200),
      endpoint(
        'GET',
        '/keyword-sets/{id}/keywords',
        'strategy.read',
        'KeywordListQuery',
        'KeywordPage',
        '-',
        200,
      ),
      endpoint(
        'POST',
        '/keyword-sets/{id}/keywords',
        'strategy.manage',
        'UpsertKeywordsRequest',
        'Keyword[]',
        'key+body_hash',
        200,
      ),
      endpoint(
        'POST',
        '/keyword-sets/{id}/keywords/batch',
        'strategy.manage',
        'BatchKeywordOperationRequest',
        'BatchKeywordOperation',
        'key+body_hash',
        200,
      ),
      endpoint(
        'POST',
        '/keyword-sets/sync-platform-scope',
        'strategy.manage',
        'SyncProjectKeywordPlatformScopeRequest',
        'ProjectKeywordPlatformScopeSync',
        'key+body_hash',
        200,
      ),
      endpoint(
        'POST',
        '/keyword-sets/{id}/imports/preflight',
        'strategy.manage',
        'KeywordImportPreflight',
        'KeywordImportJobView',
        'key+body_hash',
        201,
      ),
      endpoint(
        'POST',
        '/keyword-sets/{id}/imports/{importId}/commit',
        'strategy.manage',
        'CommitKeywordImportRequest',
        'KeywordImportJobView',
        'key+body_hash',
        202,
      ),
      endpoint(
        'GET',
        '/keyword-sets/{id}/imports/{importId}',
        'strategy.read',
        '-',
        'KeywordImportJobView',
        '-',
        200,
      ),
      endpoint(
        'POST',
        '/topic-plans/generate',
        'strategy.manage',
        'TopicPlanRequest',
        'GenerationRunView',
        'key+body_hash',
        202,
      ),
      endpoint(
        'GET',
        '/topic-candidates',
        'strategy.read',
        'TopicCandidateQuery',
        'TopicCandidatePage',
        '-',
        200,
      ),
      endpoint(
        'POST',
        '/topic-candidates/{id}/adopt',
        'strategy.manage',
        'AdoptTopicRequest',
        'BriefView',
        'resource+version',
        200,
      ),
    ]);
    expect(new Set(STRATEGY_API_CONTRACTS.map((contract) => contract.key)).size).toBe(18);
    expect(STRATEGY_API_CONTRACTS.every((contract) => Object.isFrozen(contract))).toBe(true);
  });

  it('maps tenant-member reads and strategy-editor-or-admin writes to role permissions', () => {
    for (const role of TENANT_ROLE_CODES) {
      expect(roleHasPermission(role, 'strategy.read')).toBe(true);
      expect(roleHasPermission(role, 'strategy.manage')).toBe(
        ['tenant_owner', 'tenant_admin', 'strategy_editor'].includes(role),
      );
    }
    for (const contract of STRATEGY_API_CONTRACTS) {
      expect(contract.policy).toBe(
        contract.permission === 'strategy.read' ? 'tenant_member' : 'strategy_editor_or_admin',
      );
    }
  });

  it('validates all strategy response families with strict runtime schemas', () => {
    const brand = brandProfile();
    expect(BrandProfileResponseSchema.safeParse(response(brand)).success).toBe(true);
    expect(BrandProfilePageSchema.safeParse(page([brand], null)).success).toBe(true);

    const keywordSet = {
      created_at: timestamp,
      id: id('11'),
      name: 'Core keywords',
      project_id: id('12'),
      status: 'active',
      tenant_id: id('1'),
      updated_at: timestamp,
    };
    expect(KeywordSetResponseSchema.safeParse(response(keywordSet)).success).toBe(true);
    expect(KeywordSetPageSchema.safeParse(page([keywordSet], null)).success).toBe(true);
    expect(
      KeywordSetDetailResponseSchema.safeParse(response({ ...keywordSet, keywords: [keyword()] }))
        .success,
    ).toBe(true);
    expect(KeywordListResponseSchema.safeParse(response([keyword()])).success).toBe(true);
    expect(
      BatchKeywordOperationResponseSchema.safeParse(
        response({
          action: 'disable',
          affected_count: 1,
          keyword_ids: [id('14')],
          skipped_referenced_count: 0,
        }),
      ).success,
    ).toBe(true);
    expect(
      ProjectKeywordPlatformScopeSyncResponseSchema.safeParse(
        response({
          active_keyword_count: 1,
          changed_count: 1,
          matched_count: 2,
          platform_codes: ['lieju'],
          project_id: id('12'),
        }),
      ).success,
    ).toBe(true);
    expect(GenerationRunResponseSchema.safeParse(response(generationRun())).success).toBe(true);
    expect(TopicCandidatePageSchema.safeParse(page([topicCandidate()], null)).success).toBe(true);
    expect(BriefResponseSchema.safeParse(response(brief())).success).toBe(true);
  });

  it('rejects response drift and evidence-free low-risk topics', () => {
    expect(
      BrandProfileResponseSchema.safeParse({ ...response(brandProfile()), unexpected: true })
        .success,
    ).toBe(false);
    expect(
      TopicCandidatePageSchema.safeParse(
        page([{ ...topicCandidate(), evidence_ids: [], risk_level: 'low' }], null),
      ).success,
    ).toBe(false);
  });
});

function endpoint(
  method: 'GET' | 'POST',
  path: string,
  permission: 'strategy.read' | 'strategy.manage',
  request: string,
  responseName: string,
  idempotency: '-' | 'key+body_hash' | 'resource+version',
  status: 200 | 201 | 202,
) {
  return { idempotency, method, path, permission, request, response: responseName, status };
}

function response(data: unknown) {
  return { data, meta: { request_id: requestId } };
}

function page(data: readonly unknown[], nextCursor: string | null) {
  return { data, meta: { next_cursor: nextCursor, request_id: requestId } };
}

function brandProfile() {
  return {
    created_at: timestamp,
    created_by: id('2'),
    id: id('10'),
    profile: {
      audience: ['Enterprise teams'],
      banned: [],
      compliance: [],
      cta: null,
      differentiators: ['Evidence first'],
      positioning: 'Enterprise GEO content operating system',
      tone: 'Professional',
    },
    published_at: null,
    schema_version: 'brand-profile@1',
    status: 'draft',
    tenant_id: id('1'),
    version: 1,
    workspace_id: id('3'),
  };
}

function keyword() {
  return {
    created_at: timestamp,
    id: id('14'),
    intents: ['informational', 'commercial'],
    keyword_set_id: id('11'),
    platform_scope: ['official_site'],
    priority: 80,
    status: 'active',
    synonyms: ['GEO operating system'],
    tenant_id: id('1'),
    term: 'GEO content system',
    updated_at: timestamp,
  };
}

function briefSuggestion() {
  return {
    audience: 'Enterprise content teams',
    constraints: {
      additional_instructions: null,
      cta: null,
      schema_version: 'brief-constraints@1',
    },
    due_at: null,
    keyword_ids: [id('14')],
    objective: 'education',
    primary_keyword_id: id('14'),
    title: 'How enterprise GEO systems work',
  };
}

function generationRun() {
  return {
    created_at: timestamp,
    error: null,
    finished_at: null,
    id: id('20'),
    input_hash: 'a'.repeat(64),
    model_key: 'mock-topic-planner',
    package_id: null,
    project_id: id('12'),
    prompt_version_id: id('21'),
    request_id: requestId,
    skill_name: 'topic-planner',
    skill_version: '1.0.0',
    started_at: null,
    status: 'queued',
    tenant_id: id('1'),
    updated_at: timestamp,
    variant_id: null,
    version: 1,
    workspace_id: id('3'),
  };
}

function topicCandidate() {
  return {
    brief_suggestion: briefSuggestion(),
    created_at: timestamp,
    entities: ['GEO'],
    evidence_ids: [id('30')],
    generation_run_id: id('20'),
    id: id('31'),
    intent: 'informational',
    platform_codes: ['official_site'],
    priority: 90,
    project_id: id('12'),
    question: 'How does an enterprise GEO content system work?',
    risk_level: 'low',
    status: 'proposed',
    tenant_id: id('1'),
    updated_at: timestamp,
    version: 1,
    workspace_id: id('3'),
  };
}

function brief() {
  return {
    ...briefSuggestion(),
    created_at: timestamp,
    created_by: id('2'),
    id: id('40'),
    platform_codes: ['official_site'],
    project_id: id('12'),
    source_ids: [id('30')],
    source_topic_candidate_id: id('31'),
    tenant_id: id('1'),
    updated_at: timestamp,
    version: 1,
    workspace_id: id('3'),
  };
}
