import { describe, expect, it } from 'vitest';

import {
  CONTENT_API_CONTRACTS,
  CONTENT_OPENAPI_DOCUMENT,
  ContentDocumentSchema,
  ContentPackageQuerySchema,
  GenerateContentRequestSchema,
  UpdateVariantRequestSchema,
} from './index.js';

const EXPECTED = [
  [
    'POST',
    '/briefs',
    'strategy_or_content_editor_or_admin',
    'CreateBriefRequest',
    'BriefView',
    'key+body_hash',
    201,
  ],
  ['GET', '/briefs', 'tenant_member', 'BriefListQuery', 'BriefPage', '-', 200],
  ['GET', '/briefs/{id}', 'tenant_member', '-', 'BriefView', '-', 200],
  [
    'PATCH',
    '/briefs/{id}',
    'strategy_or_content_editor_or_admin',
    'UpdateBriefRequest',
    'BriefView',
    'key+version',
    200,
  ],
  [
    'POST',
    '/content-packages',
    'content_editor_or_admin',
    'CreateContentPackageRequest',
    'ContentPackageView',
    'key+body_hash',
    201,
  ],
  [
    'GET',
    '/content-packages',
    'tenant_member',
    'ContentPackageQuery',
    'ContentPackagePage',
    '-',
    200,
  ],
  ['GET', '/content-packages/{id}', 'tenant_member', '-', 'ContentPackageDetail', '-', 200],
  [
    'POST',
    '/content-packages/{id}/generate',
    'content_editor_or_admin',
    'GenerateContentRequest',
    'GenerationRunView',
    'key+body_hash',
    202,
  ],
  [
    'POST',
    '/content-packages/{id}/abandon',
    'content_editor_or_admin',
    'ReasonRequest',
    'ContentPackageView',
    'resource+version',
    200,
  ],
  [
    'POST',
    '/content-packages/{id}/archive',
    'tenant_admin_or_owner',
    'ReasonRequest',
    'ContentPackageView',
    'resource+version',
    200,
  ],
  [
    'POST',
    '/content-packages/{id}/reopen',
    'reviewer_or_admin',
    'ReopenVariantsRequest',
    'ContentPackageDetail',
    'key+version',
    200,
  ],
  ['GET', '/generation-runs/{id}', 'content_editor_or_admin', '-', 'GenerationRunView', '-', 200],
  [
    'POST',
    '/generation-runs/{id}/cancel',
    'content_editor_or_admin',
    'ReasonRequest',
    'GenerationRunView',
    'resource+version',
    200,
  ],
  ['GET', '/content-versions/{id}', 'tenant_member', '-', 'ContentVersionView', '-', 200],
  [
    'GET',
    '/content-versions/{id}/diff',
    'tenant_member',
    'CompareVersionQuery',
    'ContentDiffView',
    '-',
    200,
  ],
  [
    'POST',
    '/content-versions/{id}/rollback',
    'content_editor_or_admin',
    'RollbackRequest',
    'ContentVersionView',
    'key+version',
    200,
  ],
  ['GET', '/content-variants/{id}', 'tenant_member', '-', 'ContentVariantDetail', '-', 200],
  [
    'PATCH',
    '/content-variants/{id}',
    'content_editor_or_admin',
    'UpdateVariantRequest',
    'ContentVariantDetail',
    'key+version',
    200,
  ],
  [
    'POST',
    '/content-variants/{id}/blocks/{blockId}/lock',
    'content_editor_or_admin',
    'LockBlockRequest',
    'BlockLockView',
    'resource+version',
    201,
  ],
  [
    'DELETE',
    '/content-variants/{id}/blocks/{blockId}/lock',
    'content_editor_or_admin',
    '-',
    '-',
    'resource+version',
    204,
  ],
  [
    'POST',
    '/content-variants/{id}/quality-check',
    'content_editor_or_admin',
    'QualityCheckRequest',
    'GenerationRunView',
    'key+content_hash',
    202,
  ],
  [
    'POST',
    '/content-variants/{id}/regenerate',
    'content_editor_or_admin',
    'RegenerateVariantRequest',
    'GenerationRunView',
    'key+body_hash',
    202,
  ],
  [
    'POST',
    '/content-variants/{id}/drop',
    'content_editor_or_admin',
    'DropVariantRequest',
    'ContentVariantDetail',
    'resource+version',
    200,
  ],
] as const;

describe('Content API frozen contract', () => {
  it('matches all 23 frozen endpoints exactly', () => {
    expect(CONTENT_API_CONTRACTS).toHaveLength(23);
    expect(
      CONTENT_API_CONTRACTS.map((item) => [
        item.method,
        item.path,
        item.policy,
        item.requestName,
        item.responseName,
        item.idempotency,
        item.successStatus,
      ]),
    ).toEqual(EXPECTED);
    expect(new Set(CONTENT_API_CONTRACTS.map((item) => item.key)).size).toBe(23);
    expect(new Set(CONTENT_API_CONTRACTS.map((item) => `${item.method} ${item.path}`)).size).toBe(
      23,
    );
  });

  it('projects every endpoint into executable OpenAPI 3.1 operations', () => {
    const operations = Object.entries(CONTENT_OPENAPI_DOCUMENT.paths).flatMap(([path, item]) =>
      Object.entries(item).map(([method, operation]) => ({ method, operation, path })),
    );
    expect(CONTENT_OPENAPI_DOCUMENT.openapi).toBe('3.1.0');
    expect(operations).toHaveLength(23);
    for (const contract of CONTENT_API_CONTRACTS) {
      const operation = CONTENT_OPENAPI_DOCUMENT.paths[contract.path]?.[
        contract.method.toLowerCase()
      ] as Record<string, unknown> | undefined;
      expect(operation?.['operationId']).toBe(
        contract.key.replaceAll('.', '_').replaceAll('-', '_'),
      );
      expect(operation?.['x-idempotency']).toBe(contract.idempotency);
      expect(operation?.['x-permission']).toBe(contract.permission);
    }
  });

  it('keeps server tenant context out of public write DTOs', () => {
    const writeContracts = CONTENT_API_CONTRACTS.filter(
      (item) => item.bodySchema !== null && item.method !== 'GET',
    );
    for (const contract of writeContracts) {
      expect(contract.bodySchema?.safeParse({ tenant_id: crypto.randomUUID() }).success).toBe(
        false,
      );
    }
  });

  it('validates deterministic generation and package query inputs', () => {
    expect(
      GenerateContentRequestSchema.parse({
        platform_codes: ['official_site', 'zhihu'],
      }),
    ).toEqual({
      locked_block_keys: [],
      model_policy: 'balanced',
      platform_codes: ['official_site', 'zhihu'],
    });
    expect(
      GenerateContentRequestSchema.safeParse({
        platform_codes: ['official_site', 'official_site'],
      }).success,
    ).toBe(false);
    expect(ContentPackageQuerySchema.parse({ limit: '20' }).limit).toBe(20);
    expect(ContentPackageQuerySchema.parse({ attention_required: 'true' }).attention_required).toBe(
      'true',
    );
  });

  it('requires structured immutable content for variant updates', () => {
    const content = {
      blocks: [{ block_key: 'intro', block_type: 'paragraph', text: 'Evidence-led text.' }],
      citation_map: [],
      cta: null,
      hashtags: [],
      platform_code: 'official_site',
      platform_meta: {},
      schema_version: 'content-writer-data@1',
      summary: 'Summary',
      title: 'Enterprise GEO guide',
    };
    expect(ContentDocumentSchema.safeParse(content).success).toBe(true);
    expect(UpdateVariantRequestSchema.safeParse({ content }).success).toBe(true);
    expect(
      UpdateVariantRequestSchema.safeParse({
        content: { ...content, blocks: [...content.blocks, content.blocks[0]] },
      }).success,
    ).toBe(false);
  });
});
