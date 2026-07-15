import { InMemoryStorageAdapter } from '@geo-content-os/adapter-storage';
import { describe, expect, it, vi } from 'vitest';

import {
  AnalyticsExportWorker,
  renderCsv,
  type AnalyticsExportStorePort,
} from './analytics-export.worker.js';

const TENANT_ID = '2e000000-0000-4000-8000-000000000132';
const WORKSPACE_ID = '4e000000-0000-4000-8000-000000000132';
const EXPORT_ID = '3e000000-0000-4000-8000-000000000132';

describe('analytics export worker', () => {
  it('writes deterministic CSV and handles event replay', async () => {
    const storage = new InMemoryStorageAdapter('analytics');
    const complete = vi.fn<AnalyticsExportStorePort['complete']>().mockResolvedValue(undefined);
    const store: AnalyticsExportStorePort = {
      claim: vi.fn().mockResolvedValueOnce('claimed').mockResolvedValueOnce('already_processed'),
      complete,
      fail: vi.fn(),
      snapshot: vi.fn().mockResolvedValue([
        { metric_name: 'reads', note: 'a,b', value: 2 },
        { metric_name: 'exposures', note: null, value: 10 },
      ]),
    };
    const worker = new AnalyticsExportWorker(store, storage);
    const first = await worker.run(event());
    expect(first).toMatchObject({ disposition: 'processed', exportJobId: EXPORT_ID, rowCount: 2 });
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    const body = storage.readObject(
      `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/analytics-exports/${EXPORT_ID}.csv`,
    );
    expect([...body!.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(body)).toBe(
      'metric_name,note,value\r\nreads,"a,b",2\r\nexposures,,10\r\n',
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ exportJobId: EXPORT_ID }),
      expect.objectContaining({ contentHash: first.contentHash, rowCount: 2 }),
    );
    await expect(worker.run(event())).resolves.toEqual({
      disposition: 'already_processed',
      exportJobId: EXPORT_ID,
    });
  });

  it('sorts columns and escapes spreadsheet-sensitive delimiters deterministically', () => {
    expect(renderCsv([{ z: 'line\nnext', formula: '=1+1', a: '"quoted"' }])).toBe(
      '\uFEFFa,formula,z\r\n"""quoted""",\'=1+1,"line\nnext"\r\n',
    );
  });
});

function event(): unknown {
  return {
    aggregate: { id: EXPORT_ID, type: 'analytics_export_job' },
    data: {
      analytics_export_job_id: EXPORT_ID,
      query_hash: 'a'.repeat(64),
      workspace_id: WORKSPACE_ID,
    },
    event_id: '5e000000-0000-4000-8000-000000000132',
    event_type: 'analytics.export.requested.v1',
    occurred_at: '2026-07-15T00:00:00.000Z',
    tenant: { id: TENANT_ID },
  };
}
