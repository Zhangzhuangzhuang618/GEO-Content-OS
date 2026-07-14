export type StorageDriver = 'disabled' | 'memory' | 's3';

export interface StorageConfiguration {
  readonly autoCreateBucket: boolean;
  readonly bucket: string;
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  readonly driver: StorageDriver;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly region: string;
  readonly serverSideEncryption: boolean;
}

export function readStorageConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): StorageConfiguration {
  const production = environment['NODE_ENV']?.trim() === 'production';
  const driver = readDriver(environment['STORAGE_DRIVER'], production);
  const bucket = environment['S3_BUCKET']?.trim() || 'geo-content-os-dev';
  validateBucket(bucket);
  const region = environment['S3_REGION']?.trim() || 'us-east-1';
  const endpoint = readEndpoint(environment['S3_ENDPOINT']);
  const accessKeyId = environment['S3_ACCESS_KEY_ID']?.trim();
  const secretAccessKey = environment['S3_SECRET_ACCESS_KEY'];
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured together');
  }
  if (driver === 's3' && endpoint && (!accessKeyId || !secretAccessKey)) {
    throw new Error('S3 credentials are required for an S3-compatible endpoint');
  }
  const autoCreateBucket = readBoolean(
    environment['S3_AUTO_CREATE_BUCKET'],
    false,
    'S3_AUTO_CREATE_BUCKET',
  );
  if (production && autoCreateBucket) {
    throw new Error('S3_AUTO_CREATE_BUCKET must be false in production');
  }

  return Object.freeze({
    autoCreateBucket,
    bucket,
    ...(accessKeyId && secretAccessKey
      ? { credentials: Object.freeze({ accessKeyId, secretAccessKey }) }
      : {}),
    driver,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: readBoolean(
      environment['S3_FORCE_PATH_STYLE'],
      Boolean(endpoint),
      'S3_FORCE_PATH_STYLE',
    ),
    region,
    serverSideEncryption: readBoolean(
      environment['S3_SERVER_SIDE_ENCRYPTION'],
      production,
      'S3_SERVER_SIDE_ENCRYPTION',
    ),
  });
}

function readDriver(value: string | undefined, production: boolean): StorageDriver {
  const normalized = value?.trim();
  if (production && !normalized) throw new Error('STORAGE_DRIVER=s3 is required in production');
  const driver = normalized || 'disabled';
  if (driver !== 'disabled' && driver !== 'memory' && driver !== 's3') {
    throw new Error('STORAGE_DRIVER must be disabled, memory, or s3');
  }
  if (production && driver !== 's3') throw new Error('STORAGE_DRIVER=s3 is required in production');
  return driver;
}

function readEndpoint(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('S3_ENDPOINT must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('S3_ENDPOINT must be an HTTP(S) URL without embedded credentials');
  }
  return url.toString().replace(/\/$/u, '');
}

function validateBucket(value: string): void {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value) || value.includes('..')) {
    throw new Error('S3_BUCKET must be a valid DNS-compatible bucket name');
  }
}

function readBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}
