export class CostQueryValidationError extends Error {
  public constructor(message = 'Cost query input is invalid') {
    super(message);
    this.name = 'CostQueryValidationError';
  }
}

export class CostQueryStateError extends Error {
  public constructor(message = 'Cost query scope is unavailable') {
    super(message);
    this.name = 'CostQueryStateError';
  }
}
