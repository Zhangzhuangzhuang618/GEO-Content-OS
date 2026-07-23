export class FactAdjudicationNotFoundError extends Error {
  public constructor() {
    super('Fact was not found in the authorized scope');
    this.name = 'FactAdjudicationNotFoundError';
  }
}

export class FactAdjudicationStateError extends Error {
  public constructor(message = 'Fact adjudication transition is not allowed') {
    super(message);
    this.name = 'FactAdjudicationStateError';
  }
}

export class FactAdjudicationValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FactAdjudicationValidationError';
  }
}

export class FactAdjudicationVersionConflictError extends Error {
  public constructor() {
    super('Fact revision does not match the current updated_at value');
    this.name = 'FactAdjudicationVersionConflictError';
  }
}
