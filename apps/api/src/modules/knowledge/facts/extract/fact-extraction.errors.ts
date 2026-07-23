export class FactExtractionScopeError extends Error {
  public constructor() {
    super('Fact extraction source scope was not found or is not extractable');
    this.name = 'FactExtractionScopeError';
  }
}

export class FactExtractionProvenanceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FactExtractionProvenanceError';
  }
}

export class FactExtractionValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FactExtractionValidationError';
  }
}
