export class ContentPackageNotFoundError extends Error {
  public constructor() {
    super('Content Package was not found');
    this.name = 'ContentPackageNotFoundError';
  }
}

export class ContentPackageStateError extends Error {
  public constructor(message = 'Content Package state does not allow this operation') {
    super(message);
    this.name = 'ContentPackageStateError';
  }
}

export class ContentPackageVersionConflictError extends Error {
  public constructor() {
    super('Content Package version conflict');
    this.name = 'ContentPackageVersionConflictError';
  }
}
