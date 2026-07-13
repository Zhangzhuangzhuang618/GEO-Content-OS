const DEVELOPMENT_ORIGINS = Object.freeze(['http://localhost:3000', 'http://127.0.0.1:3000']);

export interface CorsOriginOptions {
  readonly environment?: string;
}

export function parseAllowedOrigins(
  value: string | undefined,
  options: CorsOriginOptions = {},
): readonly string[] {
  const environment = options.environment ?? 'development';
  const candidates = value
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (!candidates?.length) {
    if (environment === 'production') {
      throw new Error('CORS_ALLOWED_ORIGINS is required in production');
    }
    return DEVELOPMENT_ORIGINS;
  }

  const normalized = candidates.map(normalizeOrigin);
  return Object.freeze([...new Set(normalized)]);
}

export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  try {
    return allowedOrigins.includes(normalizeOrigin(origin));
  } catch {
    return false;
  }
}

function normalizeOrigin(value: string): string {
  if (value.includes('*')) throw new Error('CORS origins must not contain wildcards');

  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported CORS origin protocol: ${parsed.protocol}`);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `CORS origin must not include credentials, a path, query, or fragment: ${value}`,
    );
  }
  return parsed.origin;
}
