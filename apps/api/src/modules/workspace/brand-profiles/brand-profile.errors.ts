export class BrandProfileNotFoundError extends Error {
  public constructor() {
    super('Brand profile is not available in the current tenant and workspace scope');
    this.name = 'BrandProfileNotFoundError';
  }
}

export class BrandProfileVersionConflictError extends Error {
  public constructor() {
    super('Brand profile version does not match the requested version');
    this.name = 'BrandProfileVersionConflictError';
  }
}

export class BrandProfileStateError extends Error {
  public constructor(message = 'Brand profile state transition is not allowed') {
    super(message);
    this.name = 'BrandProfileStateError';
  }
}

export class BrandProfileValidationError extends Error {
  public constructor(message = 'Brand profile request is invalid') {
    super(message);
    this.name = 'BrandProfileValidationError';
  }
}
