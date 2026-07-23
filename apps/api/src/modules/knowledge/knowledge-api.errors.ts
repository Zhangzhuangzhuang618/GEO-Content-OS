export class KnowledgeApiNotFoundError extends Error {
  public constructor() {
    super('Knowledge resource was not found in the authorized scope');
    this.name = 'KnowledgeApiNotFoundError';
  }
}

export class KnowledgeApiValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'KnowledgeApiValidationError';
  }
}

export class KnowledgeApiVersionConflictError extends Error {
  public constructor() {
    super('Knowledge resource revision does not match');
    this.name = 'KnowledgeApiVersionConflictError';
  }
}

export class KnowledgeApiStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'KnowledgeApiStateError';
  }
}
