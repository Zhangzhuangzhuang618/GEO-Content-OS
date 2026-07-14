export class ContentVariantNotFoundError extends Error {
  public constructor() {
    super('Content Variant was not found');
    this.name = 'ContentVariantNotFoundError';
  }
}

export class ContentVariantStateError extends Error {
  public constructor(message = 'Content Variant state does not allow this operation') {
    super(message);
    this.name = 'ContentVariantStateError';
  }
}

export class ContentVariantVersionConflictError extends Error {
  public constructor() {
    super('Content Variant version conflict');
    this.name = 'ContentVariantVersionConflictError';
  }
}
