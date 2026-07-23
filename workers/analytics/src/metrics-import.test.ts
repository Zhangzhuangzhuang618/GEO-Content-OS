import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { previewMetricsCsv } from './metrics-import.js';
import type { MetricsImportEvent } from './metrics-import.event.js';
import {
  MetricsImportWorker,
  type MetricsImportLoaderPort,
  type MetricsImportStorePort,
} from './metrics-import.worker.js';

const IMPORT_JOB_ID = 'b1000000-0000-4000-8000-000000000128';
const TENANT_ID = '21000000-0000-4000-8000-000000000128';
const WORKSPACE_ID = '31000000-0000-4000-8000-000000000128';
const CSV = [
  'platform_code,account_id,variant_id,metric_date,metric_name,metric_value',
  'official_site,,,2026-07-15,impressions,120',
  'zhihu,not-a-uuid,,2026-07-15,reads,9',
  'douyin,,,2026-07-16,engagements,3',
].join('\n');

describe('metrics import worker', () => {
  it('previews valid rows and reports deterministic line errors', () => {
    const preview = previewMetricsCsv(CSV);
    expect(preview.totalRows).toBe(3);
    expect(preview.rows).toMatchObject([
      { metricName: 'impressions', metricValue: 120, platformCode: 'official_site' },
      { metricName: 'engagements', metricValue: 3, platformCode: 'douyin' },
    ]);
    expect(preview.errors).toEqual([
      { code: 'ROW_INVALID', line: 3, message: 'CSV row is invalid' },
    ]);
  });

  it('supports quoted CSV fields and rejects the wrong header', () => {
    expect(
      previewMetricsCsv(
        'platform_code,account_id,variant_id,metric_date,metric_name,metric_value\nzhihu,,,2026-07-15,"reads",10',
      ).rows,
    ).toMatchObject([{ metricName: 'reads' }]);
    expect(previewMetricsCsv('wrong,header\n1,2').errors[0]).toMatchObject({
      code: 'HEADER_INVALID',
      line: 1,
    });
    expect(
      previewMetricsCsv(
        'platform_code,account_id,variant_id,metric_date,metric_name,metric_value\nzhihu,,,2026-02-31,reads,10',
      ).errors[0],
    ).toMatchObject({ code: 'ROW_INVALID', line: 2 });
  });

  it('validates the event and completes one claimed import', async () => {
    const body = Buffer.from(CSV);
    const complete = vi.fn<MetricsImportStorePort['complete']>().mockResolvedValue(undefined);
    const fail = vi.fn<MetricsImportStorePort['fail']>().mockResolvedValue(undefined);
    const store: MetricsImportStorePort = {
      claim: vi.fn().mockResolvedValue('claimed'),
      complete,
      fail,
    };
    const loader: MetricsImportLoaderPort = { load: vi.fn().mockResolvedValue(body) };
    const worker = new MetricsImportWorker(store, loader);
    await expect(worker.run(event(body))).resolves.toEqual({
      disposition: 'processed',
      errorCount: 1,
      importJobId: IMPORT_JOB_ID,
      validRowCount: 2,
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });

  it('does not reprocess claimed events and fails closed on content mismatch', async () => {
    const body = Buffer.from(CSV);
    const already = new MetricsImportWorker(
      {
        claim: vi.fn().mockResolvedValue('already_processed'),
        complete: vi.fn(),
        fail: vi.fn(),
      },
      { load: vi.fn() },
    );
    await expect(already.run(event(body))).resolves.toEqual({
      disposition: 'already_processed',
      importJobId: IMPORT_JOB_ID,
    });

    const fail = vi.fn<MetricsImportStorePort['fail']>().mockResolvedValue(undefined);
    const worker = new MetricsImportWorker(
      { claim: vi.fn().mockResolvedValue('claimed'), complete: vi.fn(), fail },
      { load: vi.fn().mockResolvedValue(Buffer.from('changed')) },
    );
    await expect(worker.run(event(body))).rejects.toThrow('content hash does not match');
    expect(fail).toHaveBeenCalledOnce();
  });
});

function event(body: Uint8Array): unknown {
  const data: Omit<MetricsImportEvent, 'eventId' | 'tenantId'> = {
    contentHash: createHash('sha256').update(body).digest('hex'),
    importJobId: IMPORT_JOB_ID,
    objectKey: 'tenants/metrics/import.csv',
    workspaceId: WORKSPACE_ID,
  };
  return {
    aggregate: { id: IMPORT_JOB_ID, type: 'import_job' },
    data: {
      content_hash: data.contentHash,
      import_job_id: data.importJobId,
      object_key: data.objectKey,
      workspace_id: data.workspaceId,
    },
    event_id: 'e1000000-0000-4000-8000-000000000128',
    event_type: 'analytics.metrics.import_requested.v1',
    occurred_at: '2026-07-15T00:00:00.000Z',
    tenant: { id: TENANT_ID },
  };
}
