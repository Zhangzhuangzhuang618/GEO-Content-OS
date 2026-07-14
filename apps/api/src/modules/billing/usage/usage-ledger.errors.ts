export class UsageLedgerError extends Error {
  public constructor(
    public readonly code:
      | 'USAGE_CONFLICT'
      | 'USAGE_INPUT_INVALID'
      | 'USAGE_NOT_FOUND'
      | 'USAGE_SCOPE_INVALID'
      | 'USAGE_STATE_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'UsageLedgerError';
  }
}
