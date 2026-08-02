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
      events.push('second:end');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('allows different accounts to proceed independently', async () => {
    const lock = new AccountLock();
    let releaseA = (): void => undefined;
    const aCanFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let bStarted = false;

    const a = lock.run('account-a', () => aCanFinish);
    const b = lock.run('account-b', async () => {
      bStarted = true;
    });

    await b;
    expect(bStarted).toBe(true);
    releaseA();
    await a;
  });
});
