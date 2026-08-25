import { describe, expect, it } from 'vitest';

import {
  normalizeOfficialSiteDailyTitle,
  resolveScheduleTimes,
  selectAuthorizedCertificateSourceIds,
} from './official-site-daily-scheduler.js';

const SCHEDULE = [
  '08:00:00',
  '09:30:00',
  '11:00:00',
  '12:30:00',
  '14:00:00',
  '15:30:00',
  '17:00:00',
  '18:30:00',
  '20:00:00',
  '21:30:00',
] as const;

describe('official-site daily schedule', () => {
  it.each(['搬家指南', '广州工厂搬迁怎么选：一份实用判断指南'])(
    'keeps generated brief title inside the official-site 20-60 contract: %s',
    (title) => {
      const normalized = normalizeOfficialSiteDailyTitle(title);

      expect(normalized.length).toBeGreaterThanOrEqual(20);
      expect(normalized.length).toBeLessThanOrEqual(60);
    },
  );

  it('truncates an oversized generated brief title to the official-site maximum', () => {
    const normalized = normalizeOfficialSiteDailyTitle('官网日批'.repeat(20));

    expect(normalized).toHaveLength(60);
    expect(normalized.endsWith('…')).toBe(true);
  });

  it('only authorizes certificate sources whose holder exactly matches the published owner', () => {
    expect(
      selectAuthorizedCertificateSourceIds(
        { positioning: '广东众人搬家起重吊装有限公司提供搬迁服务。' },
        [
          {
            holderName: '广东众人搬家起重吊装有限公司',
            id: '10000000-0000-4000-8000-000000000001',
          },
          {
            holderName: '广州志远搬家服务有限公司',
            id: '10000000-0000-4000-8000-000000000002',
          },
        ],
      ),
    ).toEqual(['10000000-0000-4000-8000-000000000001']);
  });

  it('keeps all ten fixed Beijing-time slots when content is ready before 08:00', () => {
    const resolved = resolveScheduleTimes(
      '2026-07-26',
      SCHEDULE,
      new Date('2026-07-25T23:00:00.000Z'),
    );

    expect(resolved.map((value) => value.toISOString())).toEqual([
      '2026-07-26T00:00:00.000Z',
      '2026-07-26T01:30:00.000Z',
      '2026-07-26T03:00:00.000Z',
      '2026-07-26T04:30:00.000Z',
      '2026-07-26T06:00:00.000Z',
      '2026-07-26T07:30:00.000Z',
      '2026-07-26T09:00:00.000Z',
      '2026-07-26T10:30:00.000Z',
      '2026-07-26T12:00:00.000Z',
      '2026-07-26T13:30:00.000Z',
    ]);
  });

  it('moves missed slots forward without changing future slots', () => {
    const resolved = resolveScheduleTimes(
      '2026-07-26',
      SCHEDULE,
      new Date('2026-07-26T02:00:00.000Z'),
    );

    expect(resolved.slice(0, 3).map((value) => value.toISOString())).toEqual([
      '2026-07-26T02:01:00.000Z',
      '2026-07-26T02:02:00.000Z',
      '2026-07-26T03:00:00.000Z',
    ]);
  });

  it('keeps all ten publications inside the business day when qualification is late', () => {
    const resolved = resolveScheduleTimes(
      '2026-07-26',
      SCHEDULE,
      new Date('2026-07-26T15:55:00.000Z'),
    );

    expect(resolved[0]?.toISOString()).toBe('2026-07-26T15:55:05.000Z');
    expect(resolved.at(-1)?.toISOString()).toBe('2026-07-26T15:58:59.999Z');
    expect(resolved.every((value) => value > new Date('2026-07-26T15:55:00.000Z'))).toBe(true);
  });
});
