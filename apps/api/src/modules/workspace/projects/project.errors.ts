export class ProjectNotFoundError extends Error {
  public constructor() {
    super('Project is not available in the current tenant and workspace scope');
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectVersionConflictError extends Error {
  public constructor() {
    super('Project version does not match the current version');
    this.name = 'ProjectVersionConflictError';
  }
}

export class ProjectStateError extends Error {
  public constructor(message = 'Project state transition is not allowed') {
    super(message);
    this.name = 'ProjectStateError';
  }
}

export class ProjectValidationError extends Error {
  public constructor(message = 'Project request is invalid') {
    super(message);
    this.name = 'ProjectValidationError';
  }
}
