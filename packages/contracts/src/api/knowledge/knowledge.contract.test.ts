import { describe, expect, it } from 'vitest';

import { TENANT_ROLE_CODES } from '../../roles.js';
import { roleHasPermission } from '../../permissions/index.js';
import {
  BatchUrlPreviewResponseSchema,
  FactPageSchema,
  IngestJobResponseSchema,
  KNOWLEDGE_API_CONTRACTS,
  SourceDetailResponseSchema,
  SourcePageSchema,
  SourceUploadResponseSchema,
} from './index.js';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const timestamp = '2026-07-14T03:00:00.000Z';
const requestId = '01J00000000000000000000000';

describe('knowledge API contract', () => {
  it('contains the frozen endpoints plus the ADR-governed batch URL preview extension', () => {
    expect(
      KNOWLEDGE_API_CONTRACTS.map((contract) => ({
        idempotency: contract.idempotency,
        method: contract.method,
        path: contract.path,
        permissions: contract.permissions,
        request: contract.requestName,
        response: contract.responseName,
        status: contract.successStatus,
      })),
    ).toEqual([
      endpoint(
        'POST',
        '/sources',
        ['knowledge.sources.manage'],
        'SourceCreate',
        'SourceView + IngestJob',
        'key+content_hash',
        201,
      ),
      endpoint(
        'POST',
        '/sources/batch-url-preview',
        ['knowledge.sources.manage'],
        'BatchUrlPreviewRequest',
        'BatchUrlPreview',
        '-',
        200,
      ),
      endpoint('GET', '/sources', ['knowledge.read'], 'SourceListQuery', 'SourcePage', '-', 200),
      endpoint(
        'GET',
        '/sources/{id}',
        ['knowledge.read'],
        'SourceScopeQuery',
        'SourceDetailView',
        '-',
        200,
      ),
      endpoint(
        'POST',
        '/sources/{id}/reindex',
        ['knowledge.sources.manage'],
        'ReindexRequest',
        'IngestJobView',
        'resource+source_hash',
        202,
      ),
      endpoint(
        'PATCH',
        '/sources/{id}/validity',
        ['knowledge.sources.manage'],
        'UpdateSourceValidityRequest',
        'SourceView',
        'resource+version',
        200,
      ),
      endpoint(
        'DELETE',
        '/sources/{id}',
        ['knowledge.sources.manage'],
        'ReasonRequest',
        '-',
        'resource+version',
        204,
      ),
      endpoint(
        'GET',
        '/ingest-jobs/{id}',
        ['knowledge.read'],
        'SourceScopeQuery',
        'IngestJobView',
        '-',
        200,
      ),
      endpoint('GET', '/facts', ['knowledge.read'], 'FactQuery', 'FactPage', '-', 200),
      endpoint(
        'POST',
        '/facts/{id}/verify',
        ['knowledge.facts.verify', 'review.decide'],
        'VerifyFactRequest',
        'FactView',
        'resource+version',
        200,
      ),
    ]);
    expect(new Set(KNOWLEDGE_API_CONTRACTS.map((contract) => contract.key)).size).toBe(10);
    expect(KNOWLEDGE_API_CONTRACTS.every((contract) => Object.isFrozen(contract))).toBe(true);
  });

  it('maps tenant reads, source writes, and fact decisions to role permissions', () => {
    for (const role of TENANT_ROLE_CODES) {
      expect(roleHasPermission(role, 'knowledge.read')).toBe(true);
      expect(roleHasPermission(role, 'knowledge.sources.manage')).toBe(
        ['tenant_owner', 'tenant_admin', 'strategy_editor', 'content_editor'].includes(role),
      );
      expect(
        roleHasPermission(role, 'knowledge.facts.verify') &&
          roleHasPermission(role, 'review.decide'),
      ).toBe(['tenant_owner', 'tenant_admin', 'reviewer'].includes(role));
    }
  });

  it('validates every response family and rejects response drift', () => {
    const source = sourceView();
    const job = ingestJob();
    const fact = factView();
    expect(
      SourceUploadResponseSchema.safeParse(response({ ingest_job: job, source })).success,
    ).toBe(true);
    expect(SourcePageSchema.safeParse(page([{ ...source, parsed_at: timestamp }])).success).toBe(
      true,
    );
    expect(
      SourceDetailResponseSchema.safeParse(
        response({
          certificate: null,
          chunks: [],
          citation_count: 1,
          facts: [fact],
          ingest_jobs: [job],
          insurance_proof: null,
          source,
        }),
      ).success,
    ).toBe(true);
    expect(IngestJobResponseSchema.safeParse(response(job)).success).toBe(true);
    expect(FactPageSchema.safeParse(page([fact])).success).toBe(true);
    expect(
      BatchUrlPreviewResponseSchema.safeParse(
        response({
          duplicate_rows: 0,
          file_name: 'urls.xlsx',
          invalid_rows: 0,
          ready_rows: 1,
          rows: [
            {
              message: null,
              row_number: 2,
              status: 'ready',
              title: '产品页',
              url: 'https://example.com/product',
            },
          ],
          sheet_name: '详细URL列表',
          sheets: ['详细URL列表'],
          start_row: 2,
          title_column: 'B',
          total_rows: 1,
          url_column: 'D',
        }),
      ).success,
    ).toBe(true);
    expect(SourcePageSchema.safeParse({ ...page([source]), unexpected: true }).success).toBe(false);
  });

  it('enforces exclusive source target, valid ranges, scope, and optimistic revisions', () => {
    const create = KNOWLEDGE_API_CONTRACTS[0]?.bodySchema;
    const base = { title: '产品手册', workspace_id: id('2') };
    expect(create?.safeParse({ ...base, url: 'https://example.com/manual' }).success).toBe(true);
    expect(create?.safeParse({ ...base, file: {}, url: 'https://example.com' }).success).toBe(
      false,
    );
    expect(create?.safeParse({ ...base }).success).toBe(false);
    expect(
      create?.safeParse({
        ...base,
        article_use_allowed: true,
        certificate_name: '道路运输经营许可证',
        certificate_number: '粤交运管许可字 2026-001',
        file: {},
        holder_name: '广州示例搬家服务有限公司',
        issuing_authority: '广州市交通运输局',
        material_kind: 'certificate',
        public_display_confirmed: true,
        verification_url: 'https://example.gov.cn/verify/2026-001',
      }).success,
    ).toBe(true);
    expect(
      create?.safeParse({
        ...base,
        effective_from: '2026-01-10',
        effective_to: '2027-01-09',
        file: {},
        insurance_type: '团体员工福利保险',
        insured_count: 11,
        insurer_name: '示例人寿保险有限公司',
        material_kind: 'insurance_proof',
        policyholder_name: '广州示例搬家服务有限公司 13800138000',
        summary_use_confirmed: true,
        trust_level: 'verified',
      }).success,
    ).toBe(false);
    expect(
      create?.safeParse({
        ...base,
        article_use_allowed: true,
        certificate_name: '道路运输经营许可证',
        certificate_number: '粤交运管许可字 2026-001',
        file: {},
        holder_name: '广州示例搬家服务有限公司',
        issuing_authority: '广州市交通运输局',
        material_kind: 'certificate',
        public_display_confirmed: false,
      }).success,
    ).toBe(false);
    expect(
      create?.safeParse({
        ...base,
        effective_from: '2026-01-10',
        effective_to: '2027-01-09',
        file: {},
        insurance_type: '团体员工福利保险',
        insured_count: 11,
        insurer_name: '示例人寿保险有限公司',
        material_kind: 'insurance_proof',
        policyholder_name: '广州示例搬家服务有限公司',
        summary_use_confirmed: true,
        trust_level: 'verified',
      }).success,
    ).toBe(true);
    expect(
      create?.safeParse({
        ...base,
        effective_from: '2026-01-10',
        effective_to: '2027-01-09',
        file: {},
        insurance_type: '团体员工福利保险',
        insured_count: 11,
        insurer_name: '示例人寿保险有限公司',
        material_kind: 'insurance_proof',
        policyholder_name: '广州示例搬家服务有限公司',
        summary_use_confirmed: false,
        trust_level: 'verified',
      }).success,
    ).toBe(false);
    expect(
      create?.safeParse({
        ...base,
        article_use_allowed: false,
        certificate_name: '道路运输经营许可证',
        certificate_number: '粤交运管许可字 2026-001',
        file: {},
        holder_name: '广州示例搬家服务有限公司',
        issuing_authority: '广州市交通运输局',
        material_kind: 'certificate',
        public_display_confirmed: false,
        verification_url: 'http://example.gov.cn/verify/2026-001',
      }).success,
    ).toBe(false);
    expect(
      create?.safeParse({
        ...base,
        effective_from: '2026-12-31',
        effective_to: '2026-01-01',
        url: 'https://example.com',
      }).success,
    ).toBe(false);
    expect(
      KNOWLEDGE_API_CONTRACTS[2]?.querySchema?.safeParse({
        project_id: id('3'),
        workspace_id: id('2'),
      }).success,
    ).toBe(true);
    expect(
      KNOWLEDGE_API_CONTRACTS[2]?.querySchema?.safeParse({ workspace_id: id('2') }).success,
    ).toBe(false);
    expect(
      KNOWLEDGE_API_CONTRACTS[5]?.bodySchema?.safeParse({
        effective_from: '2026-08-01',
        effective_to: '2027-07-31',
        reason: '修正录入错误',
      }).success,
    ).toBe(true);
    expect(
      KNOWLEDGE_API_CONTRACTS[5]?.bodySchema?.safeParse({
        effective_from: '2027-07-31',
        effective_to: '2026-08-01',
        reason: '日期颠倒',
      }).success,
    ).toBe(false);
    expect(
      KNOWLEDGE_API_CONTRACTS[9]?.bodySchema?.safeParse({
        decision: 'verified',
        expected_updated_at: timestamp,
        reason: '证据一致',
      }).success,
    ).toBe(true);
  });
});

function endpoint(
  method: string,
  path: string,
  permissions: readonly string[],
  request: string,
  responseName: string,
  idempotency: string,
  status: number,
) {
  return { idempotency, method, path, permissions, request, response: responseName, status };
}

function response<T>(data: T) {
  return { data, meta: { request_id: requestId } };
}

function page<T>(data: readonly T[]) {
  return { data, meta: { next_cursor: null, request_id: requestId } };
}

function sourceView() {
  return {
    content_hash: 'a'.repeat(64),
    created_at: timestamp,
    created_by: id('1'),
    effective_from: null,
    effective_to: null,
    id: id('10'),
    language: 'zh-CN',
    mime_type: 'text/plain',
    project_id: id('3'),
    source_type: 'txt',
    status: 'active',
    tenant_id: id('4'),
    title: '产品手册',
    trust_level: 'verified',
    updated_at: timestamp,
    workspace_id: id('2'),
  };
}

function ingestJob() {
  return {
    attempt_count: 1,
    created_at: timestamp,
    error: null,
    finished_at: timestamp,
    id: id('11'),
    progress: 100,
    source_document_id: id('10'),
    stage: 'done',
    started_at: timestamp,
    status: 'succeeded',
    tenant_id: id('4'),
    updated_at: timestamp,
  };
}

function factView() {
  return {
    confidence: 0.98,
    created_at: timestamp,
    evidence: [],
    id: id('12'),
    object_value: '30 天',
    predicate: '退款周期',
    status: 'verified',
    subject: '标准服务',
    tenant_id: id('4'),
    unit: null,
    updated_at: timestamp,
    valid_from: null,
    valid_to: null,
    workspace_id: id('2'),
  };
}
