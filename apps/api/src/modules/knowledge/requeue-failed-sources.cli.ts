import { randomUUID } from 'node:crypto';

import { createApplication } from '../../application.js';
import { IdentityAuthDatabase } from '../identity/auth/auth.database.js';
import { KnowledgeApiService } from './knowledge-api.service.js';

interface FailedSourceRow {
  readonly actorId: string;
  readonly contentHash: string;
  readonly id: string;
  readonly tenantId: string;
}

const execute = process.argv.includes('--execute');
const limit = readLimit(process.argv);
const application = await createApplication({
  enableShutdownHooks: false,
  logger: false,
  telemetryLogger: false,
});

try {
  await application.init();
  const database = application.get(IdentityAuthDatabase).client;
  const service = application.get(KnowledgeApiService);
  const rows = await database<FailedSourceRow[]>`
    SELECT
      source.created_by AS "actorId",
      source.content_hash AS "contentHash",
      source.id,
      source.tenant_id AS "tenantId"
    FROM source_documents AS source
    JOIN memberships AS actor
      ON actor.tenant_id = source.tenant_id
      AND actor.user_id = source.created_by
      AND actor.status = 'active'
      AND actor.role_code IN (
        'tenant_owner', 'tenant_admin', 'strategy_editor', 'content_editor'
      )
    WHERE source.status = 'failed'
      AND source.source_type = 'url'
      AND source.deleted_at IS NULL
      AND (
        (
          source.project_id IS NULL
          AND has_workspace_scope_access(
            source.tenant_id,
            source.workspace_id,
            source.created_by
          )
        )
        OR has_project_scope_access(
          source.tenant_id,
          source.workspace_id,
          source.project_id,
          source.created_by
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ingest_jobs AS active_job
        WHERE active_job.tenant_id = source.tenant_id
          AND active_job.source_document_id = source.id
          AND active_job.status IN ('queued', 'running')
      )
    ORDER BY source.created_at, source.id
    LIMIT ${limit}
  `;

  if (!execute) {
    writeLine(`Dry run: ${rows.length} failed URL sources are eligible for safe reindex.`);
    writeLine('Run again with --execute to create snapshots and reindex jobs.');
  } else {
    let queued = 0;
    let failed = 0;
    for (const source of rows) {
      try {
        await service.reindex(
          source.tenantId,
          source.actorId,
          source.id,
          {
            expected_content_hash: source.contentHash,
            reason: '批量修复历史 URL 解析任务',
          },
          { requestId: `knowledge-repair-${randomUUID()}` },
        );
        queued += 1;
      } catch (error) {
        failed += 1;
        const name = error instanceof Error ? error.name : 'UnknownError';
        console.error(`Failed source ${source.id}: ${name}`);
      }
    }
    writeLine(`Repair enqueue complete: queued=${queued}, failed=${failed}, total=${rows.length}.`);
    if (failed > 0) process.exitCode = 1;
  }
} finally {
  await application.close();
}

function readLimit(args: readonly string[]): number {
  const raw = args.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length);
  if (!raw) return 500;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
    throw new TypeError('--limit must be an integer between 1 and 5000');
  }
  return value;
}

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}
