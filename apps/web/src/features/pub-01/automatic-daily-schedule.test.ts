import { describe, expect, it } from 'vitest';

import { automaticDailyScheduleTimes } from './automatic-daily-schedule';

describe('automatic daily schedule', () => {
  it('keeps the existing single-article default', () => {
    expect(automaticDailyScheduleTimes(1)).toEqual(['10:00:00']);
  });

  it('spreads ten articles across the frozen official-site slots', () => {
    expect(automaticDailyScheduleTimes(10)).toEqual([
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
    ]);
  });

  it('returns the requested number of unique ordered slots for every valid target', () => {
    for (let target = 1; target <= 10; target += 1) {
      const slots = automaticDailyScheduleTimes(target);
      expect(slots).toHaveLength(target);
      expect(new Set(slots)).toHaveLength(target);
      expect([...slots].sort()).toEqual([...slots]);
    }
  });
});
