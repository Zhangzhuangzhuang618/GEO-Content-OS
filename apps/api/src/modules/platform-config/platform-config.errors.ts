export class PlatformConfigConflictError extends Error {
  public constructor() {
    super('Platform configuration version already exists');
    this.name = 'PlatformConfigConflictError';
  }
}

export class PlatformConfigNotFoundError extends Error {
  public constructor() {
    super('Platform configuration version was not found');
    this.name = 'PlatformConfigNotFoundError';
  }
}

export class PlatformConfigStateError extends Error {
  public constructor() {
    super('Platform configuration state transition is not allowed');
    this.name = 'PlatformConfigStateError';
  }
}

export class PlatformConfigValidationError extends Error {
  public constructor() {
    super('Platform configuration request is invalid');
    this.name = 'PlatformConfigValidationError';
  }
}

export class PlatformConfigVersionError extends Error {
  public constructor() {
    super('Platform configuration version is stale');
    this.name = 'PlatformConfigVersionError';
  }
}
