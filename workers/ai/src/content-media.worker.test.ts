import { describe, expect, it } from 'vitest';

import { safeError } from './content-media.worker.js';
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
});
