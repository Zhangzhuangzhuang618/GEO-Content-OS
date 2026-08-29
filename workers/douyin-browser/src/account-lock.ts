export class AccountLock {
  private readonly tails = new Map<string, Promise<void>>();

  public isBusy(accountId: string): boolean {
    return this.tails.has(accountId);
  }

  public async run<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(accountId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(accountId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(accountId) === tail) this.tails.delete(accountId);
    }
  }
}
