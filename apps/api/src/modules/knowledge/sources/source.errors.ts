export class SourceDuplicateError extends Error {
  public constructor() {
    super('An active source with the same content already exists in this workspace');
    this.name = 'SourceDuplicateError';
  }
}

export class SourceNotFoundError extends Error {
  public constructor() {
    super('Source scope was not found');
    this.name = 'SourceNotFoundError';
  }
}

export class SourceStorageError extends Error {
  public constructor() {
    super('Source object storage operation failed');
    this.name = 'SourceStorageError';
  }
}

export class SourceUploadValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SourceUploadValidationError';
  }
}
