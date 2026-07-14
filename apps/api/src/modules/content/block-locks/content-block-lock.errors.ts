export class ContentBlockLockNotFoundError extends Error {
  public constructor() {
    super('Content Block Lock target was not found');
    this.name = 'ContentBlockLockNotFoundError';
  }
}

export class ContentBlockLockValidationError extends Error {
  public constructor(message = 'Content Block Lock input is invalid') {
    super(message);
    this.name = 'ContentBlockLockValidationError';
  }
}

export class ContentBlockLockStateError extends Error {
  public constructor(message = 'Content Block Lock state does not allow this operation') {
    super(message);
    this.name = 'ContentBlockLockStateError';
  }
}

export class ContentBlockLockVersionConflictError extends Error {
  public constructor() {
    super('Content Variant version conflict');
    this.name = 'ContentBlockLockVersionConflictError';
  }
}

export class ContentBlockLockViolationError extends Error {
  public constructor(readonly blockKey: string) {
    super(`Regenerated content changed or removed locked block: ${blockKey}`);
    this.name = 'ContentBlockLockViolationError';
  }
}
