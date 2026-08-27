import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { ContentMediaWorker, douyinNoteQuality, safeError } from './content-media.worker.js';
import { validateMediaGenerationEvent } from './media-generation.event.js';

describe('content media error diagnostics', () => {
  it('includes the underlying storage cause and useful provider fields', () => {
    const cause = Object.assign(
      new Error('connect ECONNREFUSED 172.18.0.2:9000 password=minio-password'),
      {
        $metadata: { httpStatusCode: 503, requestId: 'storage-request-1' },
        address: '172.18.0.2',
        code: 'ECONNREFUSED',
        port: 9000,
        syscall: 'connect',
      },
    );
    const error = new Error('Object storage upload failed', { cause });

    const diagnostic = safeError(error);

    expect(diagnostic).toContain('Object storage upload failed');
    expect(diagnostic).toContain('caused by');
    expect(diagnostic).toContain('code=ECONNREFUSED');
    expect(diagnostic).toContain('http_status=503');
    expect(diagnostic).toContain('request_id=storage-request-1');
    expect(diagnostic).toContain('password=[REDACTED]');
    expect(diagnostic).not.toContain('minio-password');
  });

  it('stops safely when an error cause is circular', () => {
    const error = new Error('Object storage upload failed; token: storage-token');
    Object.assign(error, { cause: error });

    const diagnostic = safeError(error);

    expect(diagnostic).toContain('token: [REDACTED]');
    expect(diagnostic).toContain('circular cause');
    expect(diagnostic).not.toContain('storage-token');
  });
});

describe('manual publish media event', () => {
  it('accepts a scheduled publish job id without changing the automatic event contract', () => {
    const publishJobId = '10000000-0000-4000-8000-000000000009';
    const event = validateMediaGenerationEvent({
      aggregate: { id: '10000000-0000-4000-8000-000000000004', type: 'content_media_run' },
      data: {
        actor_user_id: '10000000-0000-4000-8000-000000000001',
        content_hash: 'a'.repeat(64),
        content_version_id: '10000000-0000-4000-8000-000000000005',
        media_run_id: '10000000-0000-4000-8000-000000000004',
        package_id: '10000000-0000-4000-8000-000000000006',
        platform_code: 'official_site',
        project_id: '10000000-0000-4000-8000-000000000007',
        publish_job_id: publishJobId,
        quality_report_id: '10000000-0000-4000-8000-000000000008',
        request_id: 'publish-media-request',
        variant_id: '10000000-0000-4000-8000-000000000010',
        workspace_id: '10000000-0000-4000-8000-000000000011',
      },
      event_id: '10000000-0000-4000-8000-000000000012',
      event_type: 'content.variant.media_generation_requested.v1',
      occurred_at: '2026-08-05T00:00:00.000Z',
      tenant: { id: '10000000-0000-4000-8000-000000000002' },
    });

    expect(event.data.publishJobId).toBe(publishJobId);
  });

  it('resumes the same scheduled Douyin job after card media is persisted', async () => {
    const publishJobId = '10000000-0000-4000-8000-000000000009';
    const payloads: Readonly<Record<string, unknown>>[] = [];
    const transaction = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('FROM quality_reports')) {
        return [
          {
            automationGate: null,
            decision: 'pass',
            generationRunId: '10000000-0000-4000-8000-000000000013',
            geoScores: {},
            issues: { issues: [] },
            score: 90,
          },
        ];
      }
      if (query.includes('UPDATE content_media_runs SET status=')) return [{ id: 'media-run' }];
      if (query.includes('FROM publish_jobs')) {
        return [
          {
            id: publishJobId,
            scheduledAt: new Date('2026-08-27T08:00:00.000Z'),
            version: 4,
          },
        ];
      }
      if (query.includes('INSERT INTO outbox_events')) {
        const payload = values.find(
          (value) =>
            typeof value === 'string' &&
            value.startsWith('{') &&
            value.includes('publishing.job.execution_requested'),
        );
        if (typeof payload === 'string') payloads.push(JSON.parse(payload));
        return [];
      }
      if (query.includes('INSERT INTO audit_events')) return [];
      throw new Error(`Unexpected SQL: ${query}`);
    }) as unknown as postgres.TransactionSql;
    const client = Object.assign(transaction, {
      begin: async <T>(callback: (sql: postgres.TransactionSql) => Promise<T>) =>
        callback(transaction),
    }) as unknown as postgres.Sql;
    const worker = new ContentMediaWorker(
      client,
      {} as never,
      null,
      {} as never,
      {} as never,
      {} as never,
      {
        enabled: true,
        generationSteps: 4,
        plannerModelKey: 'deepseek-v4-flash',
        publicBaseUrl: null,
      },
    );
    const event = validateMediaGenerationEvent({
      ...mediaEvent(),
      data: {
        ...mediaEvent().data,
        platform_code: 'douyin',
        publish_job_id: publishJobId,
      },
    });

    await (
      worker as unknown as {
        persistAndResume(
          event: unknown,
          claim: unknown,
          plan: unknown,
          assets: readonly unknown[],
          status: 'succeeded',
          diagnostics: Readonly<Record<string, unknown>>,
        ): Promise<void>;
      }
    ).persistAndResume(
      event,
      {
        content: {},
        contentHash: 'a'.repeat(64),
        createdBy: '10000000-0000-4000-8000-000000000001',
        generationModel: null,
        generationRunId: '10000000-0000-4000-8000-000000000013',
        inspectionModel: null,
        manualPublishJobId: publishJobId,
        platformCode: 'douyin',
        provider: null,
        version: 2,
      },
      { schema_version: 'douyin-note-media-plan@2' },
      [],
      'succeeded',
      {},
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      data: { job_id: publishJobId, job_version: 4 },
      event_type: 'publishing.job.execution_requested.v1',
      tenant: { id: '10000000-0000-4000-8000-000000000002' },
    });
  });
});

describe('Douyin image-note quality metadata', () => {
  it('satisfies the frozen content media quality contract', () => {
    expect(douyinNoteQuality()).toEqual({
      card_schema_version: 'douyin-note-card@2',
      decision: 'pass',
      format: '1080x1440-jpeg',
      layout: 'focus',
      method: 'deterministic_editorial_layout',
      schema_version: 'content-image-quality@1',
    });
  });
});

describe('content media run lease', () => {
  it('returns a claimed run to queued when downstream processing fails', async () => {
    const queries: string[] = [];
    const transaction = (async (strings: TemplateStringsArray) => {
      const query = strings.join('?');
      queries.push(query);
      if (query.includes('FROM content_media_runs AS run')) {
        return [
          {
            content: {},
            contentHash: 'a'.repeat(64),
            createdBy: '10000000-0000-4000-8000-000000000001',
            generationModel: null,
            generationRunId: '10000000-0000-4000-8000-000000000013',
            inspectionModel: null,
            platformCode: 'baijiahao',
            provider: null,
            status: 'queued',
            updatedAt: new Date('2026-08-05T00:00:00.000Z'),
            version: 1,
          },
        ];
      }
      if (query.includes("SET status='running'")) return [{ version: 2 }];
      if (query.includes('FROM ai_citations AS citation')) return [];
      if (query.includes("SET status='queued'")) return [{ id: 'media-run' }];
      throw new Error(`Unexpected SQL: ${query}`);
    }) as unknown as postgres.TransactionSql;
    const client = Object.assign(transaction, {
      begin: async <T>(callback: (sql: postgres.TransactionSql) => Promise<T>) =>
        callback(transaction),
    }) as unknown as postgres.Sql;
    const worker = new ContentMediaWorker(
      client,
      {
        plan: async () => {
          throw new Error('schedule publication failed');
        },
      } as never,
      null,
      {} as never,
      {} as never,
      {} as never,
      {
        enabled: true,
        generationSteps: 4,
        plannerModelKey: 'deepseek-v4-flash',
        publicBaseUrl: null,
      },
    );

    await expect(worker.run(mediaEvent())).rejects.toThrow('schedule publication failed');
    expect(queries).toEqual([
      expect.stringContaining('FROM content_media_runs AS run'),
      expect.stringContaining("SET status='running'"),
      expect.stringContaining('FROM ai_citations AS citation'),
      expect.stringContaining("SET status='queued',started_at=NULL,finished_at=NULL"),
    ]);
    const certificateQuery = queries[2] ?? '';
    expect(certificateQuery).toContain('citation.content_version_id');
    expect(certificateQuery).toContain('source.workspace_id');
    expect(certificateQuery).toContain('source.project_id');
    expect(certificateQuery).toContain("source.trust_level <> 'untrusted'");
    expect(certificateQuery).toContain("article_use_allowed')::boolean IS TRUE");
    expect(certificateQuery).toContain("public_display_confirmed')::boolean IS TRUE");
    expect(certificateQuery).toContain("brand.status='published'");
  });

  it('requeues only stale automatic media runs and preserves manual-edit lineage', async () => {
    const queries: string[] = [];
    const payloads: Readonly<Record<string, unknown>>[] = [];
    const sourcePublishJobId = '10000000-0000-4000-8000-000000000014';
    const transaction = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');
      queries.push(query);
      if (query.includes('FROM content_media_runs AS run')) {
        return [
          {
            contentHash: 'a'.repeat(64),
            contentVersionId: '10000000-0000-4000-8000-000000000005',
            createdBy: '10000000-0000-4000-8000-000000000001',
            id: '10000000-0000-4000-8000-000000000004',
            packageId: '10000000-0000-4000-8000-000000000006',
            platformCode: 'baijiahao',
            projectId: '10000000-0000-4000-8000-000000000007',
            qualityReportId: '10000000-0000-4000-8000-000000000008',
            sourcePublishJobId,
            tenantId: '10000000-0000-4000-8000-000000000002',
            validationMode: 'manual_edit',
            variantId: '10000000-0000-4000-8000-000000000010',
            workspaceId: '10000000-0000-4000-8000-000000000011',
          },
        ];
      }
      if (query.includes('STALE_MEDIA_RUN_RECOVERED')) return [{ id: 'media-run' }];
      if (query.includes('INSERT INTO outbox_events')) {
        const payload = values.find(
          (value) =>
            typeof value === 'string' &&
            value.startsWith('{') &&
            value.includes('media_generation_requested'),
        );
        if (typeof payload === 'string') payloads.push(JSON.parse(payload));
        return [];
      }
      throw new Error(`Unexpected SQL: ${query}`);
    }) as unknown as postgres.TransactionSql;
    const client = Object.assign(transaction, {
      begin: async <T>(callback: (sql: postgres.TransactionSql) => Promise<T>) =>
        callback(transaction),
    }) as unknown as postgres.Sql;
    const worker = new ContentMediaWorker(
      client,
      {} as never,
      null,
      {} as never,
      {} as never,
      {} as never,
      {
        enabled: true,
        generationSteps: 4,
        plannerModelKey: 'deepseek-v4-flash',
        publicBaseUrl: null,
      },
    );

    await expect(worker.recoverStaleRuns(new Date('2026-08-05T00:00:00.000Z'))).resolves.toBe(1);
    expect(queries).toEqual([
      expect.stringContaining("run.status='running'"),
      expect.stringContaining('STALE_MEDIA_RUN_RECOVERED'),
      expect.stringContaining('INSERT INTO outbox_events'),
    ]);
    expect(payloads[0]?.['data']).toMatchObject({
      source_publish_job_id: sourcePublishJobId,
      validation_mode: 'manual_edit',
    });
  });
});

function mediaEvent() {
  return {
    aggregate: { id: '10000000-0000-4000-8000-000000000004', type: 'content_media_run' },
    data: {
      actor_user_id: '10000000-0000-4000-8000-000000000001',
      content_hash: 'a'.repeat(64),
      content_version_id: '10000000-0000-4000-8000-000000000005',
      media_run_id: '10000000-0000-4000-8000-000000000004',
      package_id: '10000000-0000-4000-8000-000000000006',
      platform_code: 'baijiahao',
      project_id: '10000000-0000-4000-8000-000000000007',
      quality_report_id: '10000000-0000-4000-8000-000000000008',
      request_id: 'automatic-media-request',
      variant_id: '10000000-0000-4000-8000-000000000010',
      workspace_id: '10000000-0000-4000-8000-000000000011',
    },
    event_id: '10000000-0000-4000-8000-000000000012',
    event_type: 'content.variant.media_generation_requested.v1',
    occurred_at: '2026-08-05T00:00:00.000Z',
    tenant: { id: '10000000-0000-4000-8000-000000000002' },
  };
}
