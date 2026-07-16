export class PlatformTenantConflictError extends Error {
  public constructor() {
    super('Platform tenant conflicts with an existing resource');
    this.name = 'PlatformTenantConflictError';
  }
}

export class PlatformTenantNotFoundError extends Error {
  public constructor() {
    super('Platform tenant was not found');
    this.name = 'PlatformTenantNotFoundError';
  }
}

export class PlatformTenantStateError extends Error {
  public constructor() {
    super('Platform tenant state transition is invalid');
    this.name = 'PlatformTenantStateError';
  }
}

export class PlatformTenantVersionError extends Error {
  public constructor() {
    super('Platform tenant version does not match');
    this.name = 'PlatformTenantVersionError';
  }
}
