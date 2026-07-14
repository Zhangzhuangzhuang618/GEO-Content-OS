export class GenerationOrchestrationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GenerationOrchestrationError';
  }
}

export function generationNotFound(): GenerationOrchestrationError {
  return new GenerationOrchestrationError('GENERATION_NOT_FOUND', 'Content package was not found');
}

export function generationStateInvalid(message: string): GenerationOrchestrationError {
  return new GenerationOrchestrationError('GENERATION_STATE_INVALID', message);
}

export function generationVersionConflict(): GenerationOrchestrationError {
  return new GenerationOrchestrationError(
    'GENERATION_VERSION_CONFLICT',
    'Content package version is stale',
  );
}

export function generationInputInvalid(message: string): GenerationOrchestrationError {
  return new GenerationOrchestrationError('GENERATION_INPUT_INVALID', message);
}
