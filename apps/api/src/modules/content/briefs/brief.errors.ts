export class BriefNotFoundError extends Error {
  public constructor() {
    super('Brief resource was not found');
    this.name = 'BriefNotFoundError';
  }
}

export class BriefStateError extends Error {
  public constructor(message = 'Brief state does not allow this operation') {
    super(message);
    this.name = 'BriefStateError';
  }
}

export class BriefValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BriefValidationError';
  }
}

export class BriefVersionConflictError extends Error {
  public constructor() {
    super('Brief version conflict');
    this.name = 'BriefVersionConflictError';
  }
}
