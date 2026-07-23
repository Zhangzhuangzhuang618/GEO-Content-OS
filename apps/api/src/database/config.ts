const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const LOCAL_DATABASE_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const PROTECTED_DATABASE_NAMES = new Set(['postgres', 'template0', 'template1']);
const DEVELOPMENT_DATABASE_NAME = /(?:_dev|_development|_local|_test)$/u;

export interface DatabaseEnvironment {
  readonly ALLOW_REMOTE_DATABASE_RESET?: string;
  readonly ALLOW_UNSAFE_DATABASE_RESET?: string;
  readonly DATABASE_URL?: string;
}

export interface FreshDatabaseOptions {
  readonly force: boolean;
  readonly environment?: DatabaseEnvironment;
}

export function readDatabaseUrl(environment: DatabaseEnvironment = process.env): string {
  const databaseUrl = environment.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  parsePostgresUrl(databaseUrl);
  return databaseUrl;
}

export function assertFreshDatabaseAllowed(
  databaseUrl: string,
  options: FreshDatabaseOptions,
): URL {
  if (!options.force) {
    throw new Error('Fresh migration requires the explicit --force flag');
  }

  const parsedUrl = parsePostgresUrl(databaseUrl);
  const environment = options.environment ?? process.env;
  const databaseName = decodeURIComponent(parsedUrl.pathname.slice(1));

  if (!databaseName || PROTECTED_DATABASE_NAMES.has(databaseName)) {
    throw new Error(
      `Refusing to reset protected PostgreSQL database: ${databaseName || '<empty>'}`,
    );
  }

  const isLocalHost = LOCAL_DATABASE_HOSTS.has(parsedUrl.hostname);
  if (!isLocalHost && environment.ALLOW_REMOTE_DATABASE_RESET !== 'true') {
    throw new Error('Refusing to reset a remote database without ALLOW_REMOTE_DATABASE_RESET=true');
  }

  if (
    !DEVELOPMENT_DATABASE_NAME.test(databaseName) &&
    environment.ALLOW_UNSAFE_DATABASE_RESET !== 'true'
  ) {
    throw new Error(
      'Fresh migration is limited to *_dev, *_development, *_local, or *_test databases',
    );
  }

  return parsedUrl;
}

function parsePostgresUrl(databaseUrl: string): URL {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid URL');
  }

  if (!POSTGRES_PROTOCOLS.has(parsedUrl.protocol)) {
    throw new Error('DATABASE_URL must use the postgres:// or postgresql:// protocol');
  }

  return parsedUrl;
}
