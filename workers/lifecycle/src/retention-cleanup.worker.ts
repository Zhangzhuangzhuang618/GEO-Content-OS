import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';

export interface RetentionCleanupCandidate {
  readonly objectUris: readonly string[];
  readonly tenantId: string;
}

export interface RetentionCleanupStorePort {
  complete(candidate: RetentionCleanupCandidate): Promise<void>;
  due(cutoff: Date): Promise<readonly RetentionCleanupCandidate[]>;
  fail(candidate: RetentionCleanupCandidate, message: string): Promise<void>;
}

export interface RetentionCleanupResult {
  readonly deletedObjectCount: number;
  readonly dryRun: boolean;
  readonly tenantCount: number;
}

export class RetentionCleanupWorker {
  public constructor(
    private readonly store: RetentionCleanupStorePort,
    private readonly storage: ObjectStorageAdapter,
  ) {}

  public async run(input: {
    readonly dryRun: boolean;
    readonly now: Date;
    readonly retentionDays: number;
  }): Promise<RetentionCleanupResult> {
    if (
      Number.isNaN(input.now.getTime()) ||
      !Number.isInteger(input.retentionDays) ||
      input.retentionDays < 1 ||
      input.retentionDays > 3_650
    ) {
      throw new TypeError('Retention cleanup input is invalid');
    }
    const cutoff = new Date(input.now.getTime() - input.retentionDays * 86_400_000);
    const candidates = await this.store.due(cutoff);
    if (input.dryRun) {
      return Object.freeze({
        deletedObjectCount: 0,
        dryRun: true,
        tenantCount: candidates.length,
      });
    }
    let deletedObjectCount = 0;
    for (const candidate of candidates) {
      try {
        for (const uri of candidate.objectUris) {
          await this.storage.deleteObject(objectKeyFromUri(uri));
          deletedObjectCount += 1;
        }
        await this.store.complete(candidate);
      } catch {
        await this.store.fail(candidate, 'Tenant retention cleanup failed');
      }
    }
    return Object.freeze({
      deletedObjectCount,
      dryRun: false,
      tenantCount: candidates.length,
    });
  }
}

function objectKeyFromUri(uri: string): string {
  const match = /^(?:s3|memory):\/\/[^/]+\/(.+)$/u.exec(uri);
  if (!match?.[1] || match[1].includes('..')) throw new TypeError('Object URI is invalid');
  return match[1];
}
