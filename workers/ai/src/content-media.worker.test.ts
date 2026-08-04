import { describe, expect, it } from 'vitest';

import { safeError } from './content-media.worker.js';

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
