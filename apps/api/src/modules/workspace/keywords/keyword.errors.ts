export class KeywordNotFoundError extends Error {
  public constructor() {
    super('Keyword resource was not found');
    this.name = 'KeywordNotFoundError';
  }
}

export class KeywordStateError extends Error {
  public constructor(message = 'Keyword resource state does not allow this operation') {
    super(message);
    this.name = 'KeywordStateError';
  }
}

export class KeywordValidationError extends Error {
  public constructor(message = 'Keyword query is invalid') {
    super(message);
    this.name = 'KeywordValidationError';
  }
}
