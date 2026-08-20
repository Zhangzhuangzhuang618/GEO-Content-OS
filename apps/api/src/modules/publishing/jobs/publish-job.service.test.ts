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
const PUBLICATION_ID = '91000000-0000-4000-8000-000000000130';
const DAILY_BATCH_ID = '92000000-0000-4000-8000-000000000130';
const RESCHEDULED_AT = '2026-08-01T02:30:00.000Z';

const SCOPE: PublishJobScope = {
  requestId: 'request-publish-reschedule-130',
  tenantId: TENANT_ID,
  userId: USER_ID,
};

describe('PublishJobService rescheduling', () => {
  it('cancels a scheduled official-site edit safely and retires its daily item', async () => {
    const sqlStatements: string[] = [];
    const sqlValues: unknown[] = [];
    const before = jobRow({
      origin: 'official_site_automation',
      status: 'scheduled',
      variantStatus: 'scheduled',
    });
    const transaction = createCancellationTransaction(before, sqlStatements, sqlValues);
    const client = Object.assign(vi.fn(), {
      begin: vi.fn(async (work: (value: TransactionSql) => Promise<unknown>) => work(transaction)),
    });
    const outbox = {
      enqueue: vi.fn().mockResolvedValue({ event_id: EVENT_ID }),
    } as unknown as OutboxWriter;
    const audit = {
      record: vi.fn().mockResolvedValue(undefined),
    } as unknown as RequiredAuditWriter;
    const service = new PublishJobService(client as never, outbox, audit);

    const result = await service.cancel(SCOPE, JOB_ID, 1, '人工修改已排期内容并重新质检。');

    expect(result).toMatchObject({ status: 'cancelled', version: 2 });
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE official_site_automation_runs') && sql.includes("status='disabled'"),
      ),
    ).toBe(true);
    expect(JSON.stringify(sqlValues)).toContain('PUBLISH_CANCELLED_BY_USER');
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE official_site_daily_batch_items') &&
          sql.includes("status='retired'") &&
          sql.includes('publish_job_id=NULL') &&
          sql.includes('scheduled_at=NULL') &&
          sql.includes('qualified_at=NULL') &&
          sql.includes('PUBLISH_CANCELLED_BY_USER'),
      ),
    ).toBe(true);
    expect(JSON.stringify(sqlValues)).toContain(JOB_ID);
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: 'publish_job.cancelled' }),
    );
  });

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
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE official_site_daily_batches AS batch') &&
          sql.includes("batch.last_error_json->>'code'='DAILY_PUBLISH_FAILED'"),
      ),
    ).toBe(true);
    expect(outbox.enqueue).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: 'publish_job.rescheduled' }),
    );
  });

  it('does not route another platform manual-required error through Baijiahao resolution', async () => {
    const sqlStatements: string[] = [];
    const before = jobRow({
      attemptCount: 1,
      origin: 'manual',
      packageStatus: 'publish_failed',
      status: 'failed',
      variantStatus: 'publish_failed',
    });
    const transaction = createTransaction(before, sqlStatements, {
      attemptNo: 1,
      errorCode: 'MANUAL_REQUIRED',
      status: 'failed',
    });
    const { service } = createService();

    await expect(
      service.retryInTransaction(transaction, SCOPE, JOB_ID, 1, {
        scheduled_at: RESCHEDULED_AT,
      }),
    ).resolves.toMatchObject({ status: 'scheduled', version: 2 });
  });

  it('keeps the unknown attempt immutable and safely retries after a not-published confirmation', async () => {
    const sqlStatements: string[] = [];
    const before = jobRow({
      attemptCount: 3,
      origin: 'manual',
      packageStatus: 'publish_failed',
      platformCode: 'baijiahao',
      status: 'failed',
      variantStatus: 'publish_failed',
    });
    const transaction = createUnknownResolutionTransaction(before, sqlStatements, 'not_published');
    const { audit, outbox, service } = createService();

    const result = await service.resolveUnknownInTransaction(transaction, SCOPE, JOB_ID, 1, {
      resolution: 'not_published',
    });

    expect(result).toMatchObject({ status: 'scheduled', version: 2 });
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE baijiahao_browser_publications') &&
          sql.includes("status='prepared'") &&
          sql.includes('submitted_at=NULL'),
      ),
    ).toBe(true);
    expect(sqlStatements.some((sql) => sql.includes('UPDATE publish_attempts'))).toBe(false);
    expect(outbox.enqueue).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: 'publish_job.unknown_resolved_not_published' }),
    );
  });

  it('confirms an externally verified Baijiahao article without rewriting the unknown attempt', async () => {
    const sqlStatements: string[] = [];
    const before = jobRow({
      attemptCount: 3,
      origin: 'manual',
      packageStatus: 'publish_failed',
      platformCode: 'baijiahao',
      status: 'failed',
      variantStatus: 'publish_failed',
    });
    const transaction = createUnknownResolutionTransaction(before, sqlStatements, 'published');
    const { audit, outbox, service } = createService();

    const result = await service.resolveUnknownInTransaction(transaction, SCOPE, JOB_ID, 1, {
      external_post_id: 'baijiahao-post-130',
      external_url: 'https://baijiahao.baidu.com/s?id=130',
      resolution: 'published',
    });

    expect(result).toMatchObject({
      external_post_id: 'baijiahao-post-130',
      external_url: 'https://baijiahao.baidu.com/s?id=130',
      status: 'published',
      version: 2,
    });
    expect(sqlStatements.filter((sql) => sql.includes('UPDATE content_variants'))).toHaveLength(2);
    expect(sqlStatements.some((sql) => sql.includes('UPDATE publish_attempts'))).toBe(false);
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: 'publish_job.unknown_resolved_published' }),
    );
  });

  it('restores a manually verified Baijiahao automation after browser handling is required', async () => {
    const sqlStatements: string[] = [];
    const before = jobRow({
      attemptCount: 2,
      origin: 'baijiahao_automation',
      packageStatus: 'publish_failed',
      platformCode: 'baijiahao',
      status: 'failed',
      variantStatus: 'publish_failed',
    });
    const transaction = createUnknownResolutionTransaction(before, sqlStatements, 'not_published', {
      attemptNo: 2,
      errorCode: 'MANUAL_REQUIRED',
      status: 'failed',
    });
    const { audit, outbox, service } = createService();

    const result = await service.resolveUnknownInTransaction(transaction, SCOPE, JOB_ID, 1, {
      resolution: 'not_published',
    });

    expect(result).toMatchObject({ status: 'scheduled', version: 2 });
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE baijiahao_automation_runs') && sql.includes("status='scheduled'"),
      ),
    ).toBe(true);
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE baijiahao_daily_batch_items') && sql.includes("'manual_required'"),
      ),
    ).toBe(true);
    expect(outbox.enqueue).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: 'publish_job.unknown_resolved_not_published' }),
    );
  });

  it('records a verified manual-required Baijiahao automation as published', async () => {
    const sqlStatements: string[] = [];
    const before = jobRow({
      attemptCount: 2,
      origin: 'baijiahao_automation',
      packageStatus: 'publish_failed',
      platformCode: 'baijiahao',
      status: 'failed',
      variantStatus: 'publish_failed',
    });
    const transaction = createUnknownResolutionTransaction(before, sqlStatements, 'published', {
      attemptNo: 2,
      errorCode: 'MANUAL_REQUIRED',
      status: 'failed',
    });
    const { outbox, service } = createService();

    const result = await service.resolveUnknownInTransaction(transaction, SCOPE, JOB_ID, 1, {
      external_post_id: 'baijiahao-post-130',
      external_url: 'https://baijiahao.baidu.com/s?id=130',
      resolution: 'published',
    });

    expect(result).toMatchObject({ status: 'published', version: 2 });
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE baijiahao_automation_runs') && sql.includes("status='published'"),
      ),
    ).toBe(true);
    expect(sqlStatements.some((sql) => sql.includes('UPDATE publish_attempts'))).toBe(false);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('closes an exhausted Baijiahao automation after it is verified as not published', async () => {
    const sqlStatements: string[] = [];
    const before = jobRow({
      attemptCount: 3,
      origin: 'baijiahao_automation',
      packageStatus: 'publish_failed',
      platformCode: 'baijiahao',
      status: 'failed',
      variantStatus: 'publish_failed',
    });
    const transaction = createUnknownResolutionTransaction(
      before,
      sqlStatements,
      'not_published_closed',
      { attemptNo: 3, errorCode: 'MANUAL_REQUIRED', status: 'failed' },
    );
    const { audit, outbox, service } = createService();

    const result = await service.resolveUnknownInTransaction(transaction, SCOPE, JOB_ID, 1, {
      resolution: 'not_published_closed',
    });

    expect(result).toMatchObject({ status: 'cancelled', version: 2 });
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE baijiahao_browser_publications') &&
          sql.includes("status='failed'") &&
          sql.includes('last_reconciled_at=now()'),
      ),
    ).toBe(true);
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE baijiahao_automation_runs') && sql.includes("status='disabled'"),
      ),
    ).toBe(true);
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE baijiahao_daily_batch_items') && sql.includes("status='retired'"),
      ),
    ).toBe(true);
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: 'publish_job.unknown_resolved_not_published_closed' }),
    );
  });

  it('does not close a Baijiahao automation while a safe retry remains', async () => {
    const sqlStatements: string[] = [];
    const before = jobRow({
      attemptCount: 2,
      origin: 'baijiahao_automation',
      packageStatus: 'publish_failed',
      platformCode: 'baijiahao',
      status: 'failed',
      variantStatus: 'publish_failed',
    });
    const transaction = createUnknownResolutionTransaction(
      before,
      sqlStatements,
      'not_published_closed',
      { attemptNo: 2, errorCode: 'MANUAL_REQUIRED', status: 'failed' },
    );
    const { outbox, service } = createService();

    await expect(
      service.resolveUnknownInTransaction(transaction, SCOPE, JOB_ID, 1, {
        resolution: 'not_published_closed',
      }),
    ).rejects.toMatchObject({ code: 'PUBLISH_JOB_STATE_INVALID' });
    expect(sqlStatements.some((sql) => sql.includes('UPDATE publish_jobs SET'))).toBe(false);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('closes a manually verified Sohu automation run and daily item as published', async () => {
    const sqlStatements: string[] = [];
    const before = jobRow({
      attemptCount: 2,
      origin: 'sohu_automation',
      packageStatus: 'publish_failed',
      platformCode: 'sohu',
      status: 'failed',
      variantStatus: 'publish_failed',
    });
    const transaction = createUnknownResolutionTransaction(before, sqlStatements, 'published', {
      attemptNo: 2,
      errorCode: 'MANUAL_REQUIRED',
      status: 'failed',
    });
    const { outbox, service } = createService();

    const result = await service.resolveUnknownInTransaction(transaction, SCOPE, JOB_ID, 1, {
      external_post_id: 'sohu-post-153',
      external_url: 'https://www.sohu.com/a/153',
      resolution: 'published',
    });

    expect(result).toMatchObject({ status: 'published', version: 2 });
    expect(
      sqlStatements.some(
        (sql) =>
          sql.includes('UPDATE browser_platform_automation_runs') &&
          sql.includes("status='published'"),
      ),
    ).toBe(true);
    expect(
      sqlStatements.some((sql) => sql.includes('UPDATE browser_platform_daily_batch_items')),
    ).toBe(true);
    expect(outbox.enqueue).not.toHaveBeenCalled();
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

function createTransaction(
  before: ReturnType<typeof jobRow>,
  sqlStatements: string[],
  latestAttempt?: {
    readonly attemptNo: number;
    readonly errorCode: string | null;
    readonly status: 'failed' | 'unknown';
  },
) {
  return vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    sqlStatements.push(sql);
    if (sql.includes('FROM publish_jobs AS job')) return [before];
    if (sql.includes('FROM publish_attempts')) return latestAttempt ? [latestAttempt] : [];
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
    if (sql.includes('UPDATE official_site_daily_batch_items')) {
      return [{ batchId: DAILY_BATCH_ID }];
    }
    return [];
  }) as unknown as TransactionSql;
}

function createCancellationTransaction(
  before: ReturnType<typeof jobRow>,
  sqlStatements: string[],
  sqlValues: unknown[],
) {
  return vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    sqlStatements.push(sql);
    sqlValues.push(...values);
    if (sql.includes('FROM publish_jobs AS job')) return [before];
    if (sql.includes('UPDATE publish_jobs SET')) {
      return [{ ...before, status: 'cancelled', version: before.version + 1 }];
    }
    if (sql.includes('UPDATE content_variants')) return [{ id: VARIANT_ID }];
    if (sql.includes('UPDATE official_site_automation_runs')) return [{ id: AUTOMATION_ID }];
    if (sql.includes('FROM content_variants') && sql.includes('is_required')) {
      return [{ isRequired: true, status: 'quality_passed' }];
    }
    if (sql.includes('UPDATE content_packages')) return [{ id: PACKAGE_ID }];
    return [];
  }) as unknown as TransactionSql;
}

function createUnknownResolutionTransaction(
  before: ReturnType<typeof jobRow>,
  sqlStatements: string[],
  resolution: 'not_published' | 'not_published_closed' | 'published',
  latestAttempt: {
    readonly attemptNo: number;
    readonly errorCode: string | null;
    readonly status: 'failed' | 'unknown';
  } = { attemptNo: 3, errorCode: null, status: 'unknown' },
) {
  return vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    sqlStatements.push(sql);
    if (sql.includes('FROM publish_jobs AS job')) return [before];
    if (sql.includes('FROM publish_attempts')) return [latestAttempt];
    if (sql.includes('_browser_publications') && sql.includes('FOR UPDATE')) {
      return [{ externalPostId: null, id: PUBLICATION_ID }];
    }
    if (sql.includes('UPDATE') && sql.includes('_browser_publications')) {
      return [{ id: PUBLICATION_ID }];
    }
    if (sql.includes('UPDATE publish_jobs SET')) {
      return [
        {
          ...before,
          externalPostId:
            resolution === 'published'
              ? before.platformCode === 'sohu'
                ? 'sohu-post-153'
                : 'baijiahao-post-130'
              : null,
          externalUrl:
            resolution === 'published'
              ? before.platformCode === 'sohu'
                ? 'https://www.sohu.com/a/153'
                : 'https://baijiahao.baidu.com/s?id=130'
              : null,
          publishedAt: resolution === 'published' ? new Date() : null,
          scheduledAt: resolution === 'not_published' ? new Date() : before.scheduledAt,
          status:
            resolution === 'published'
              ? 'published'
              : resolution === 'not_published_closed'
                ? 'cancelled'
                : 'scheduled',
          version: before.version + 1,
        },
      ];
    }
    if (sql.includes('UPDATE content_variants')) return [{ id: VARIANT_ID }];
    if (sql.includes('FROM content_variants') && sql.includes('is_required')) {
      return [
        {
          isRequired: true,
          status:
            resolution === 'published'
              ? 'published'
              : resolution === 'not_published_closed'
                ? 'quality_passed'
                : 'scheduled',
        },
      ];
    }
    if (sql.includes('UPDATE content_packages')) return [{ id: PACKAGE_ID }];
    if (sql.includes('UPDATE baijiahao_automation_runs')) return [{ id: AUTOMATION_ID }];
    if (sql.includes('UPDATE browser_platform_automation_runs')) return [{ id: AUTOMATION_ID }];
    if (sql.includes('UPDATE browser_platform_daily_batch_items')) {
      return [{ batchId: DAILY_BATCH_ID }];
    }
    return [];
  }) as unknown as TransactionSql;
}

function jobRow({
  attemptCount = 0,
  origin,
  packageStatus = 'scheduled',
  platformCode = 'official_site',
  status,
  variantStatus,
  variantVersion = 2,
}: {
  attemptCount?: number;
  origin:
    | 'baijiahao_automation'
    | 'lieju_automation'
    | 'manual'
    | 'official_site_automation'
    | 'sohu_automation';
  packageStatus?: 'generated' | 'publish_failed' | 'scheduled';
  platformCode?: 'baijiahao' | 'lieju' | 'official_site' | 'sohu';
  status: 'cancelled' | 'failed' | 'scheduled';
  variantStatus: 'publish_failed' | 'quality_passed' | 'scheduled';
  variantVersion?: number;
}) {
  return {
    accountCapabilities: { publish: true },
    accountDeletedAt: null,
    accountId: ACCOUNT_ID,
    accountPublishMode: 'api' as const,
    accountStatus: 'active' as const,
    accountTokenExpiresAt: null,
    attemptCount,
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
    platformCode,
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
