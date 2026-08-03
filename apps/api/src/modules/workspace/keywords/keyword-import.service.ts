import {
  KeywordImportSummarySchema,
  type CommitKeywordImportRequest,
  type KeywordImportJobView,
} from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { TransactionSql } from 'postgres';

import { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import { OutboxWriter } from '../../outbox/index.js';
import { KeywordStateError, KeywordValidationError } from './keyword.errors.js';
import type { ParsedKeywordImportPreflight } from './keyword-import.parser.js';
import {
  assertKeywordManager,
  findKeywordSet,
  lockKeywordSet,
  type KeywordAuditContext,
} from './keyword.service.js';

interface KeywordImportJobRow {
  readonly candidateCount: number;
  readonly contentHash: string;
  readonly createdAt: Date | string;
  readonly error: unknown;
  readonly fileName: string;
  readonly foldedRowCount: number;
  readonly id: string;
  readonly importedCount: number;
  readonly invalidRowCount: number;
  readonly keywordSetId: string;
  readonly selectedCount: number;
  readonly sheetName: string;
  readonly status: KeywordImportJobView['status'];
  readonly summary: unknown;
  readonly tenantId: string;
  readonly totalRowCount: number;
  readonly updatedAt: Date | string;
}

@Injectable()
export class KeywordImportService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
  ) {}

  public async stage(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    keywordSetId: string,
    input: ParsedKeywordImportPreflight,
    audit: KeywordAuditContext,
  ): Promise<KeywordImportJobView> {
    await assertKeywordManager(transaction, tenantId, actorUserId);
    const keywordSet = await lockKeywordSet(transaction, tenantId, actorUserId, keywordSetId);
    if (
      keywordSet.status !== 'active' ||
      keywordSet.projectStatus !== 'active' ||
      keywordSet.workspaceStatus !== 'active'
    ) {
      throw new KeywordStateError();
    }
    const jobs = await transaction<KeywordImportJobRow[]>`
      INSERT INTO keyword_import_jobs (
        tenant_id,
        keyword_set_id,
        file_name,
        content_hash,
        sheet_name,
        header_row,
        total_row_count,
        candidate_count,
        folded_row_count,
        invalid_row_count,
        summary_json,
        created_by
      ) VALUES (
        ${tenantId},
        ${keywordSetId},
        ${input.fileName},
        ${input.contentHash},
        ${input.sheetName},
        ${input.headerRow},
        ${input.totalRowCount},
        ${input.candidates.length},
        ${input.foldedRowCount},
        ${input.invalidRowCount},
        ${JSON.stringify(input.summary)}::text::jsonb,
        ${actorUserId}
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        keyword_set_id AS "keywordSetId",
        file_name AS "fileName",
        content_hash AS "contentHash",
        sheet_name AS "sheetName",
        status,
        total_row_count AS "totalRowCount",
        candidate_count AS "candidateCount",
        folded_row_count AS "foldedRowCount",
        invalid_row_count AS "invalidRowCount",
        selected_count AS "selectedCount",
        imported_count AS "importedCount",
        summary_json AS summary,
        error_json AS error,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const job = jobs[0];
    if (!job) throw new Error('Keyword import job insert returned no row');

    const candidates = input.candidates.map((candidate) => ({
      cluster_key: candidate.clusterKey,
      intents: candidate.intents,
      metadata_json: candidate.metadata,
      row_number: candidate.rowNumber,
      source_intent: candidate.sourceIntent,
      suggested_page_type: candidate.suggestedPageType,
      synonyms: candidate.synonyms,
      term: candidate.term,
    }));
    const inserted = await transaction<{ count: number }[]>`
      WITH input_candidate AS (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(candidates)}::text::jsonb) AS item(
          cluster_key text,
          intents varchar(32)[],
          metadata_json jsonb,
          row_number integer,
          source_intent text,
          suggested_page_type text,
          synonyms text[],
          term text
        )
      ), inserted AS (
        INSERT INTO keyword_import_candidates (
          tenant_id,
          import_job_id,
          row_number,
          term,
          intents,
          synonyms,
          source_intent,
          suggested_page_type,
          cluster_key,
          metadata_json
        )
        SELECT
          ${tenantId},
          ${job.id},
          row_number,
          term,
          intents,
          synonyms,
          source_intent,
          suggested_page_type,
          cluster_key,
          metadata_json
        FROM input_candidate
        ORDER BY row_number
        RETURNING id
      )
      SELECT count(*)::integer AS count FROM inserted
    `;
    if (inserted[0]?.count !== input.candidates.length) {
      throw new Error('Keyword import candidate insert returned an incomplete batch');
    }
    const view = toJobView(job);
    await insertImportAudit(transaction, {
      action: 'keyword_import.preflight_created',
      actorUserId,
      after: view,
      audit,
      importJobId: job.id,
      keywordSetId,
      tenantId,
    });
    return view;
  }

  public async commit(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    keywordSetId: string,
    importJobId: string,
    input: CommitKeywordImportRequest,
    audit: KeywordAuditContext,
  ): Promise<KeywordImportJobView> {
    await assertKeywordManager(transaction, tenantId, actorUserId);
    const keywordSet = await lockKeywordSet(transaction, tenantId, actorUserId, keywordSetId);
    if (
      keywordSet.status !== 'active' ||
      keywordSet.projectStatus !== 'active' ||
      keywordSet.workspaceStatus !== 'active'
    ) {
      throw new KeywordStateError();
    }
    const jobs = await transaction<KeywordImportJobRow[]>`
      SELECT
        id,
        tenant_id AS "tenantId",
        keyword_set_id AS "keywordSetId",
        file_name AS "fileName",
        content_hash AS "contentHash",
        sheet_name AS "sheetName",
        status,
        total_row_count AS "totalRowCount",
        candidate_count AS "candidateCount",
        folded_row_count AS "foldedRowCount",
        invalid_row_count AS "invalidRowCount",
        selected_count AS "selectedCount",
        imported_count AS "importedCount",
        summary_json AS summary,
        error_json AS error,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM keyword_import_jobs
      WHERE
        id = ${importJobId}
        AND tenant_id = ${tenantId}
        AND keyword_set_id = ${keywordSetId}
      FOR UPDATE
    `;
    const before = jobs[0];
    if (!before) throw new KeywordValidationError('Keyword import job does not exist');
    if (before.status !== 'preflight_ready') throw new KeywordStateError();
    const counts = await transaction<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM keyword_import_candidates
      WHERE
        tenant_id = ${tenantId}
        AND import_job_id = ${importJobId}
        AND source_intent = ANY(${input.selected_source_intents}::varchar[])
        AND suggested_page_type = ANY(${input.selected_page_types}::varchar[])
    `;
    const selectedCount = counts[0]?.count ?? 0;
    if (selectedCount === 0) throw new KeywordValidationError('No candidates match the selection');
    const options = {
      platform_scope: input.platform_scope,
      priority: input.priority,
      selected_page_types: input.selected_page_types,
      selected_source_intents: input.selected_source_intents,
      status: input.status,
    };
    const updated = await transaction<KeywordImportJobRow[]>`
      UPDATE keyword_import_jobs
      SET
        status = 'queued',
        selected_count = ${selectedCount},
        options_json = ${JSON.stringify(options)}::text::jsonb,
        error_json = NULL
      WHERE id = ${importJobId} AND tenant_id = ${tenantId}
      RETURNING
        id,
        tenant_id AS "tenantId",
        keyword_set_id AS "keywordSetId",
        file_name AS "fileName",
        content_hash AS "contentHash",
        sheet_name AS "sheetName",
        status,
        total_row_count AS "totalRowCount",
        candidate_count AS "candidateCount",
        folded_row_count AS "foldedRowCount",
        invalid_row_count AS "invalidRowCount",
        selected_count AS "selectedCount",
        imported_count AS "importedCount",
        summary_json AS summary,
        error_json AS error,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const job = updated[0];
    if (!job) throw new Error('Keyword import job update returned no row');
    await this.outboxWriter.enqueue(
      {
        aggregateId: importJobId,
        aggregateType: 'keyword_import_job',
        data: { import_job_id: importJobId, keyword_set_id: keywordSetId },
        eventType: 'strategy.keyword_import.requested.v1',
        tenantId,
      },
      transaction,
    );
    const view = toJobView(job);
    await insertImportAudit(transaction, {
      action: 'keyword_import.queued',
      actorUserId,
      after: view,
      audit,
      before: toJobView(before),
      importJobId,
      keywordSetId,
      tenantId,
    });
    return view;
  }

  public async find(
    tenantId: string,
    actorUserId: string,
    keywordSetId: string,
    importJobId: string,
  ): Promise<KeywordImportJobView> {
    return this.database.client.begin(async (transaction) => {
      await findKeywordSet(transaction, tenantId, actorUserId, keywordSetId);
      const jobs = await transaction<KeywordImportJobRow[]>`
        SELECT
          id,
          tenant_id AS "tenantId",
          keyword_set_id AS "keywordSetId",
          file_name AS "fileName",
          content_hash AS "contentHash",
          sheet_name AS "sheetName",
          status,
          total_row_count AS "totalRowCount",
          candidate_count AS "candidateCount",
          folded_row_count AS "foldedRowCount",
          invalid_row_count AS "invalidRowCount",
          selected_count AS "selectedCount",
          imported_count AS "importedCount",
          summary_json AS summary,
          error_json AS error,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM keyword_import_jobs
        WHERE
          id = ${importJobId}
          AND tenant_id = ${tenantId}
          AND keyword_set_id = ${keywordSetId}
        LIMIT 1
      `;
      const job = jobs[0];
      if (!job) throw new KeywordValidationError('Keyword import job does not exist');
      return toJobView(job);
    });
  }
}

function toJobView(row: KeywordImportJobRow): KeywordImportJobView {
  const summary = KeywordImportSummarySchema.parse(row.summary);
  const error = row.error as KeywordImportJobView['error'];
  return {
    candidate_count: row.candidateCount,
    content_hash: row.contentHash,
    created_at: new Date(row.createdAt).toISOString(),
    error,
    file_name: row.fileName,
    folded_row_count: row.foldedRowCount,
    id: row.id,
    imported_count: row.importedCount,
    invalid_row_count: row.invalidRowCount,
    keyword_set_id: row.keywordSetId,
    selected_count: row.selectedCount,
    sheet_name: row.sheetName,
    status: row.status,
    summary,
    tenant_id: row.tenantId,
    total_row_count: row.totalRowCount,
    updated_at: new Date(row.updatedAt).toISOString(),
  };
}

async function insertImportAudit(
  transaction: TransactionSql,
  input: {
    readonly action: string;
    readonly actorUserId: string;
    readonly after: unknown;
    readonly audit: KeywordAuditContext;
    readonly before?: unknown;
    readonly importJobId: string;
    readonly keywordSetId: string;
    readonly tenantId: string;
  },
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    INSERT INTO audit_events (
      tenant_id,
      actor_id,
      action,
      resource_type,
      resource_id,
      before_json,
      after_json,
      ip,
      request_id
    ) VALUES (
      ${input.tenantId},
      ${input.actorUserId},
      ${input.action},
      'keyword_set',
      ${input.keywordSetId},
      ${input.before === undefined ? null : JSON.stringify(input.before)}::text::jsonb,
      ${JSON.stringify({ import_job_id: input.importJobId, job: input.after })}::text::jsonb,
      ${input.audit.ip ?? null},
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required keyword import audit write failed');
}
