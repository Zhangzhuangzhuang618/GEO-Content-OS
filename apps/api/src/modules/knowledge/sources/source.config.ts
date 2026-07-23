const MEBIBYTE = 1_024 * 1_024;
const DEFAULT_MAX_FILE_BYTES = 25 * MEBIBYTE;
const ABSOLUTE_MAX_FILE_BYTES = 100 * MEBIBYTE;

export interface SourceUploadConfiguration {
  readonly maxFileBytes: number;
}

export function readSourceUploadConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): SourceUploadConfiguration {
  const raw = environment['SOURCE_UPLOAD_MAX_BYTES']?.trim();
  const maxFileBytes = raw ? Number(raw) : DEFAULT_MAX_FILE_BYTES;
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes < 1 ||
    maxFileBytes > ABSOLUTE_MAX_FILE_BYTES
  ) {
    throw new Error(
      `SOURCE_UPLOAD_MAX_BYTES must be an integer between 1 and ${ABSOLUTE_MAX_FILE_BYTES}`,
    );
  }
  return Object.freeze({ maxFileBytes });
}
