export class SupportAccessNotFoundError extends Error {
  public constructor() {
    super('Support access grant or target is not available in the authorized scope');
    this.name = 'SupportAccessNotFoundError';
  }
}

export class SupportAccessValidationError extends Error {
  public constructor() {
    super('Support access request violates its bounded lifetime or scope');
    this.name = 'SupportAccessValidationError';
  }
}
