import { describe, expect, it } from 'vitest';

import { AccountLock } from './account-lock.js';

describe('AccountLock', () => {
  it('serializes work for one account', async () => {
    const lock = new AccountLock();
    const events: string[] = [];
    let releaseFirst = (): void => undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = lock.run('account-a', async () => {
      events.push('first:start');
      await firstCanFinish;
      events.push('first:end');
    });
    const second = lock.run('account-a', async () => {
      events.push('second:start');
    });
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    expect(lock.isBusy('account-a')).toBe(true);
    expect(lock.isBusy('account-b')).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    expect(lock.isBusy('account-a')).toBe(false);
  });
});
