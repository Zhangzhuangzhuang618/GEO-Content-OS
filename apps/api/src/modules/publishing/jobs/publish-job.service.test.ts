import type { TransactionSql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import type { RequiredAuditWriter } from '../../audit/index.js';
import type { OutboxWriter } from '../../outbox/index.js';
import { PublishJobService } from './publish-job.service.js';
import type { PublishJobScope } from './publish-job.types.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000130';
const USER_ID = '20000000-0000-4000-8000-000000000130';
const JOB_ID = '30000000-0000-4000-8000-000000000130';
const VARIANT_ID = '40000000-0000-4000-8000-000000000130';
const CONTENT_VERSION_ID = '50000000-0000-4000-8000-000000000130';
const ACCOUNT_ID = '60000000-0000-4000-8000-000000000130';
const PACKAGE_ID = '70000000-0000-4000-8000-000000000130';
const EVENT_ID = '80000000-0000-4000-8000-000000000130';
const AUTOMATION_ID = '90000000-0000-4000-8000-000000000130';
const RESCHEDULED_AT = '2026-08-01T02:30:00.000Z';

const SCOPE: PublishJobScope = {
  requestId: 'request-publish-reschedule-130',
  tenantId: TENANT_ID,
  userId: USER_ID,
};

describe('PublishJobService rescheduling', () => {
  it('reschedules the same scheduled job and supersedes its pending execution event', async () => {
    const sqlStatements: string[] = [];
    const before = jobRow({ origin: 'manual', status: 'scheduled', variantStatus: 'scheduled' });
    const transaction = createTransaction(before, sqlStatements);
    const { audit, outbox, service } = createService();

    const result = await service.retryInTransaction(
      transaction,
      SCOPE,
      JOB_ID,
      1,
      { scheduled_at: RESCHEDULED_AT },
      new Date(RESCHEDULED_AT),
    );

    expect(result).toMatchObject({
      id: JOB_ID,
      scheduled_at: RESCHEDULED_AT,
      status: 'scheduled',
      version: 2,
    });
    expect(sqlStatements.some((sql) => sql.includes('UPDATE content_variants'))).toBe(false);
    expect(sqlStatements.some((sql) => sql.includes('UPDATE content_packages'))).toBe(false);
    expect(sqlStatements.some((sql) => sql.includes('Superseded by publish job reschedule'))).toBe(
      true,
    );
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: JOB_ID,
        data: expect.objectContaining({
          job_id: JOB_ID,
          job_version: 2,
          scheduled_at: RESCHEDULED_AT,
        }),
      }),
      transaction,
    );
    expect(audit.record).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: 'publish_job.rescheduled' }),
    );
  });

  it('restores a cancelled official-site job, its article and automation run', async () => {
    const sqlStatements: string[] = [];
    const before = jobRow({
      origin: 'official_site_automation',
      packageStatus: 'generated',
      status: 'cancelled',
      variantStatus: 'quality_passed',
      variantVersion: 3,
    });
    const transaction = createTransaction(before, sqlStatements);
    const { audit, outbox, service } = createService();

    const result = await service.retryInTransaction(
      transaction,
      SCOPE,
      JOB_ID,
      1,
      { scheduled_at: RESCHEDULED_AT },
      new Date(RESCHEDULED_AT),
    );

    expect(result).toMatchObject({
      id: JOB_ID,
      origin: 'official_site_automation',
      scheduled_at: RESCHEDULED_AT,
      status: 'scheduled',
      version: 2,
    });
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE content_variants') &&
          sql.includes('status=?') &&
          sql.includes('version=version+1'),
      ),
    ).toBe(true);
    expect(
      sqlStatements.some(
        (sql) => sql.includes('UPDATE official_site_automation_runs') && sql.includes('status=?'),
      ),
    ).toBe(true);
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE official_site_daily_batch_items') &&
          sql.includes("status='scheduled'"),
      ),
    ).toBe(true);
    expect(outbox.enqueue).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: 'publish_job.rescheduled' }),
    );
  });
});

function createService() {
  const outbox = {
    enqueue: vi.fn().mockResolvedValue({ event_id: EVENT_ID }),
  } as unknown as OutboxWriter;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as RequiredAuditWriter;
  return {
    audit,
    outbox,
    service: new PublishJobService({} as never, outbox, audit),
  };
}

function createTransaction(before: ReturnType<typeof jobRow>, sqlStatements: string[]) {
  return vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    sqlStatements.push(sql);
    if (sql.includes('FROM publish_jobs AS job')) return [before];
    if (sql.includes('SELECT status FROM publish_attempts')) return [];
    if (sql.includes('UPDATE publish_jobs SET')) {
      return [
        {
          ...before,
          scheduledAt: values.find((value) => value === RESCHEDULED_AT) ?? RESCHEDULED_AT,
          status: 'scheduled',
          version: before.version + 1,
        },
      ];
    }
    if (sql.includes('UPDATE content_variants')) return [{ id: VARIANT_ID }];
    if (sql.includes('FROM content_variants') && sql.includes('is_required')) {
      return [{ isRequired: true, status: 'scheduled' }];
    }
    if (sql.includes('UPDATE content_packages')) return [{ id: PACKAGE_ID }];
    if (sql.includes('UPDATE official_site_automation_runs')) return [{ id: AUTOMATION_ID }];
    return [];
  }) as unknown as TransactionSql;
}

function jobRow({
  origin,
  packageStatus = 'scheduled',
  status,
  variantStatus,
  variantVersion = 2,
}: {
  origin: 'manual' | 'official_site_automation';
  packageStatus?: 'generated' | 'scheduled';
  status: 'cancelled' | 'scheduled';
  variantStatus: 'quality_passed' | 'scheduled';
  variantVersion?: number;
}) {
  return {
    accountCapabilities: { publish: true },
    accountDeletedAt: null,
    accountId: ACCOUNT_ID,
    accountPublishMode: 'api' as const,
    accountStatus: 'active' as const,
    accountTokenExpiresAt: null,
    attemptCount: 0,
    contentVersionId: CONTENT_VERSION_ID,
    createdAt: '2026-07-30T00:00:00.000Z',
    createdBy: USER_ID,
    externalPostId: null,
    externalUrl: null,
    id: JOB_ID,
    idempotencyKey: 'publish-job-reschedule-130',
    isRequired: true,
    lastError: null,
    origin,
    packageId: PACKAGE_ID,
    packageStatus,
    packageVersion: 2,
    payloadHash: 'a'.repeat(64),
    platformCode: 'official_site' as const,
    publishedAt: null,
    scheduledAt: '2026-07-31T02:30:00.000Z',
    status,
    tenantId: TENANT_ID,
    updatedAt: '2026-07-30T00:00:00.000Z',
    variantCurrentContentVersionId: CONTENT_VERSION_ID,
    variantId: VARIANT_ID,
    variantStatus,
    variantVersion,
    version: 1,
  };
}
