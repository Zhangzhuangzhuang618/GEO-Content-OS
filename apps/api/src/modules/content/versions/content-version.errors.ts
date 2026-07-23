export class ContentVersionNotFoundError extends Error {
  public constructor() {
    super('Content Version was not found');
    this.name = 'ContentVersionNotFoundError';
  }
}

export class ContentVersionValidationError extends Error {
  public constructor(message = 'Content Version content is invalid') {
    super(message);
    this.name = 'ContentVersionValidationError';
  }
}

export class ContentVersionStateError extends Error {
  public constructor(message = 'Content Version state does not allow this operation') {
    super(message);
    this.name = 'ContentVersionStateError';
  }
}

export class ContentVersionVersionConflictError extends Error {
  public constructor() {
    super('Content aggregate version conflict');
    this.name = 'ContentVersionVersionConflictError';
  }
}
