export class WorkspaceNotFoundError extends Error {
  public constructor() {
    super('Workspace is not available in the current tenant scope');
    this.name = 'WorkspaceNotFoundError';
  }
}

export class WorkspaceVersionConflictError extends Error {
  public constructor() {
    super('Workspace version does not match the current version');
    this.name = 'WorkspaceVersionConflictError';
  }
}

export class WorkspaceStateError extends Error {
  public constructor(message = 'Workspace state transition is not allowed') {
    super(message);
    this.name = 'WorkspaceStateError';
  }
}

export class WorkspaceValidationError extends Error {
  public constructor(message = 'Workspace request is invalid') {
    super(message);
    this.name = 'WorkspaceValidationError';
  }
}
