export class InvitationPermissionError extends Error {
  public constructor() {
    super('Invitation action is not allowed');
    this.name = 'InvitationPermissionError';
  }
}

export class InvitationConflictError extends Error {
  public constructor() {
    super('Invitation conflicts with current membership or pending invitation');
    this.name = 'InvitationConflictError';
  }
}

export class InvitationNotFoundError extends Error {
  public constructor() {
    super('Invitation was not found in the authorized scope');
    this.name = 'InvitationNotFoundError';
  }
}

export class InvitationAuthenticationError extends Error {
  public constructor() {
    super('Invitation cannot be accepted with the supplied credentials');
    this.name = 'InvitationAuthenticationError';
  }
}
