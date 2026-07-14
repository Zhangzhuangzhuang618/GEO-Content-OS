export class RequiredAuditWriteError extends Error {
  public readonly code = 'AUDIT_WRITE_REQUIRED';

  public constructor(cause: unknown) {
    super('Required audit write failed', { cause });
    this.name = 'RequiredAuditWriteError';
  }
}
