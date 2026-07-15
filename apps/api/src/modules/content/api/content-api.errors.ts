export type ContentApiErrorKind = 'not_found' | 'state' | 'validation' | 'version';

export class ContentApiError extends Error {
  public constructor(
    public readonly kind: ContentApiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ContentApiError';
  }
}

export function contentNotFound(): ContentApiError {
  return new ContentApiError('not_found', 'Content resource was not found');
}

export function contentStateInvalid(message: string): ContentApiError {
  return new ContentApiError('state', message);
}

export function contentValidationInvalid(message: string): ContentApiError {
  return new ContentApiError('validation', message);
}

export function contentVersionConflict(): ContentApiError {
  return new ContentApiError('version', 'Content resource version is stale');
}
