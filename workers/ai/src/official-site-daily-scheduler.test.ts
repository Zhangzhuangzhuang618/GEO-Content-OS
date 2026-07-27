import { describe, expect, it } from 'vitest';

import { resolveScheduleTimes } from './official-site-daily-scheduler.js';

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
