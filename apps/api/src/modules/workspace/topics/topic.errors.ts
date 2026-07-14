export class TopicNotFoundError extends Error {
  public constructor() {
    super('Topic resource was not found');
    this.name = 'TopicNotFoundError';
  }
}

export class TopicStateError extends Error {
  public constructor(message = 'Topic resource state does not allow this operation') {
    super(message);
    this.name = 'TopicStateError';
  }
}

export class TopicValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TopicValidationError';
  }
}

export class TopicVersionConflictError extends Error {
  public constructor() {
    super('Topic candidate version conflict');
    this.name = 'TopicVersionConflictError';
  }
}
