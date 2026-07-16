export class MembershipNotFoundError extends Error {
  public constructor() {
    super('Membership is not available in the current tenant');
    this.name = 'MembershipNotFoundError';
  }
}

export class MembershipPermissionError extends Error {
  public constructor() {
    super('Membership action is not permitted');
    this.name = 'MembershipPermissionError';
  }
}

export class MembershipStateError extends Error {
  public constructor(message = 'Membership state transition is not allowed') {
    super(message);
    this.name = 'MembershipStateError';
  }
}

export class MembershipValidationError extends Error {
  public constructor(message = 'Membership request is invalid') {
    super(message);
    this.name = 'MembershipValidationError';
  }
}

export class MembershipVersionConflictError extends Error {
  public constructor() {
    super('Membership version does not match the current version');
    this.name = 'MembershipVersionConflictError';
  }
}
