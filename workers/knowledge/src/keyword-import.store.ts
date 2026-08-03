import {
  CommitKeywordImportRequestSchema,
  type CommitKeywordImportRequest,
} from '@geo-content-os/contracts';
import type postgres from 'postgres';

import { KeywordImportWorkerError, type KeywordImportEvent } from './keyword-import.event.js';
import type {
  KeywordImportCandidate,
  KeywordImportClaim,
  KeywordImportStorePort,
} from './keyword-import.worker.js';

interface JobRow {
  readonly options: unknown;
  readonly status: string;
}

export class PostgresKeywordImportStore implements KeywordImportStorePort {
  public constructor(private readonly client: postgres.Sql) {}

  public async claim(event: KeywordImportEvent): Promise<'already_processed' | KeywordImportClaim> {
    return this.client.begin(async (transaction) => {
      const jobs = await transaction<JobRow[]>`
        SELECT status, options_json AS options
        FROM keyword_import_jobs
        WHERE
          id = ${event.importJobId}
          AND tenant_id = ${event.tenantId}
          AND keyword_set_id = ${event.keywordSetId}
        FOR UPDATE
      `;
      const job = jobs[0];
      if (!job) throw new KeywordImportWorkerError('Keyword import job does not exist');
      if (job.status === 'succeeded') return 'already_processed';
      if (!['queued', 'running'].includes(job.status)) {
        throw new KeywordImportWorkerError('Keyword import job is not runnable');
      }
      const options = CommitKeywordImportRequestSchema.safeParse(job.options);
      if (!options.success)
        throw new KeywordImportWorkerError('Keyword import options are invalid');
      if (job.status === 'queued') {
        await transaction`
          UPDATE keyword_import_jobs
          SET status = 'running', error_json = NULL
          WHERE id = ${event.importJobId} AND tenant_id = ${event.tenantId}
        `;
      }
      return Object.freeze({ options: options.data });
    });
  }

  public async nextBatch(
    event: KeywordImportEvent,
    options: CommitKeywordImportRequest,
    limit: number,
  ): Promise<readonly KeywordImportCandidate[]> {
    return this.client<KeywordImportCandidate[]>`
      SELECT
        candidate.row_number AS "rowNumber",
        candidate.term::text AS term,
        candidate.intents,
        candidate.synonyms,
        candidate.metadata_json AS metadata
      FROM keyword_import_candidates AS candidate
      JOIN keyword_import_jobs AS job
        ON job.id = candidate.import_job_id
        AND job.tenant_id = candidate.tenant_id
      WHERE
        candidate.tenant_id = ${event.tenantId}
        AND candidate.import_job_id = ${event.importJobId}
        AND job.keyword_set_id = ${event.keywordSetId}
        AND job.status = 'running'
        AND candidate.row_number > job.last_row_number
        AND candidate.source_intent = ANY(${options.selected_source_intents}::varchar[])
        AND candidate.suggested_page_type = ANY(${options.selected_page_types}::varchar[])
      ORDER BY candidate.row_number
      LIMIT ${limit}
    `;
  }

  public async applyBatch(
    event: KeywordImportEvent,
    options: CommitKeywordImportRequest,
    candidates: readonly KeywordImportCandidate[],
  ): Promise<void> {
    if (candidates.length === 0 || candidates.length > 500) {
      throw new KeywordImportWorkerError('Keyword import batch is invalid');
    }
    await this.client.begin(async (transaction) => {
      const jobs = await transaction<{ lastRowNumber: number; status: string }[]>`
        SELECT status, last_row_number AS "lastRowNumber"
        FROM keyword_import_jobs
        WHERE id = ${event.importJobId} AND tenant_id = ${event.tenantId}
        FOR UPDATE
      `;
      const job = jobs[0];
      if (!job || job.status !== 'running') {
        throw new KeywordImportWorkerError('Keyword import job lost its running state');
      }
      const pending = candidates.filter((candidate) => candidate.rowNumber > job.lastRowNumber);
      if (pending.length === 0) return;
      const input = pending.map((candidate) => ({
        intents: candidate.intents,
        metadata_json: candidate.metadata,
        row_number: candidate.rowNumber,
        synonyms: candidate.synonyms,
        term: candidate.term,
      }));
      const upserted = await transaction<{ count: number }[]>`
        WITH input_keyword AS (
          SELECT *
          FROM jsonb_to_recordset(${JSON.stringify(input)}::text::jsonb) AS item(
            intents varchar(32)[],
            metadata_json jsonb,
            row_number integer,
            synonyms text[],
            term text
          )
        ), changed AS (
          INSERT INTO keywords (
            tenant_id,
            keyword_set_id,
            term,
            intent,
            intents,
            priority,
            synonyms,
            platform_scope,
            status,
            import_metadata_json,
            source_import_job_id
          )
          SELECT
            ${event.tenantId},
            ${event.keywordSetId},
            input_keyword.term,
            input_keyword.intents[1],
            input_keyword.intents,
            ${options.priority},
            input_keyword.synonyms,
            ${options.platform_scope}::varchar[],
            ${options.status},
            input_keyword.metadata_json,
            ${event.importJobId}
          FROM input_keyword
          ORDER BY input_keyword.row_number
          ON CONFLICT (tenant_id, keyword_set_id, term) DO UPDATE SET
            intent = EXCLUDED.intent,
            intents = EXCLUDED.intents,
            priority = EXCLUDED.priority,
            synonyms = (
              SELECT COALESCE(array_agg(value ORDER BY value), '{}'::text[])
              FROM (
                SELECT DISTINCT ON (lower(value)) value
                FROM unnest(keywords.synonyms || EXCLUDED.synonyms) AS value
                WHERE lower(value) <> lower(keywords.term::text)
                ORDER BY lower(value), value
                LIMIT 50
              ) AS merged
            ),
            platform_scope = EXCLUDED.platform_scope,
            status = CASE
              WHEN EXCLUDED.status = 'active' THEN 'active'
              ELSE keywords.status
            END,
            import_metadata_json = EXCLUDED.import_metadata_json,
            source_import_job_id = EXCLUDED.source_import_job_id,
            updated_at = now()
          RETURNING id
        )
        SELECT count(*)::integer AS count FROM changed
      `;
      if (upserted[0]?.count !== pending.length) {
        throw new KeywordImportWorkerError('Keyword import upsert returned an incomplete batch');
      }
      const lastRowNumber = pending.at(-1)?.rowNumber;
      if (!lastRowNumber) throw new KeywordImportWorkerError('Keyword import cursor is invalid');
      await transaction`
        UPDATE keyword_import_jobs
        SET
          imported_count = imported_count + ${pending.length},
          last_row_number = ${lastRowNumber}
        WHERE id = ${event.importJobId} AND tenant_id = ${event.tenantId}
      `;
    });
  }

  public async complete(event: KeywordImportEvent): Promise<void> {
    await this.client.begin(async (transaction) => {
      const jobs = await transaction<
        {
          createdBy: string;
          importedCount: number;
          selectedCount: number;
          status: string;
        }[]
      >`
        SELECT
          status,
          selected_count AS "selectedCount",
          imported_count AS "importedCount",
          created_by AS "createdBy"
        FROM keyword_import_jobs
        WHERE id = ${event.importJobId} AND tenant_id = ${event.tenantId}
        FOR UPDATE
      `;
      const job = jobs[0];
      if (!job) throw new KeywordImportWorkerError('Keyword import job does not exist');
      if (job.status === 'succeeded') return;
      if (job.status !== 'running' || job.importedCount !== job.selectedCount) {
        throw new KeywordImportWorkerError(
          'Keyword import did not process every selected candidate',
        );
      }
      await transaction`
        UPDATE keyword_import_jobs
        SET status = 'succeeded', error_json = NULL
        WHERE id = ${event.importJobId} AND tenant_id = ${event.tenantId}
      `;
      const audit = await transaction<{ id: string }[]>`
        INSERT INTO audit_events (
          tenant_id,
          actor_id,
          action,
          resource_type,
          resource_id,
          after_json,
          request_id
        ) VALUES (
          ${event.tenantId},
          ${job.createdBy},
          'keyword_import.completed',
          'keyword_set',
          ${event.keywordSetId},
          ${JSON.stringify({
            import_job_id: event.importJobId,
            imported_count: job.importedCount,
            status: 'succeeded',
          })}::text::jsonb,
          ${event.eventId}
        )
        RETURNING id
      `;
      if (audit.length !== 1) {
        throw new KeywordImportWorkerError('Required keyword import audit write failed');
      }
    });
  }

  public async fail(event: KeywordImportEvent, message: string): Promise<void> {
    await this.client`
      UPDATE keyword_import_jobs
      SET
        status = 'failed',
        error_json = ${JSON.stringify({
          code: 'KEYWORD_IMPORT_FAILED',
          message: message.slice(0, 2_000),
          schema_version: 'keyword-import-error@1',
        })}::text::jsonb
      WHERE
        id = ${event.importJobId}
        AND tenant_id = ${event.tenantId}
        AND status IN ('queued', 'running')
    `;
  }
}
