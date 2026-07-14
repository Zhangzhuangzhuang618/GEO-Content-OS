const MEBIBYTE = 1_024 * 1_024;
const DEFAULT_MAX_BYTES = 10 * MEBIBYTE;
const ABSOLUTE_MAX_BYTES = 25 * MEBIBYTE;
const DEFAULT_TIMEOUT_MS = 10_000;
const ABSOLUTE_TIMEOUT_MS = 30_000;

export interface WebFetchConfiguration {
  readonly allowedHosts: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly deniedHosts: readonly string[];
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly timeoutMs: number;
  readonly userAgent: string;
}

export function readWebFetchConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): WebFetchConfiguration {
  return Object.freeze({
    allowedHosts: parseHosts(environment['WEB_FETCH_ALLOWED_HOSTS']),
    allowedPorts: parsePorts(environment['WEB_FETCH_ALLOWED_PORTS']),
    deniedHosts: parseHosts(environment['WEB_FETCH_DENIED_HOSTS']),
    maxBytes: parseInteger(
      environment['WEB_FETCH_MAX_BYTES'],
      DEFAULT_MAX_BYTES,
      1,
      ABSOLUTE_MAX_BYTES,
      'WEB_FETCH_MAX_BYTES',
    ),
    maxRedirects: parseInteger(
      environment['WEB_FETCH_MAX_REDIRECTS'],
      5,
      0,
      10,
      'WEB_FETCH_MAX_REDIRECTS',
    ),
    timeoutMs: parseInteger(
      environment['WEB_FETCH_TIMEOUT_MS'],
      DEFAULT_TIMEOUT_MS,
      100,
      ABSOLUTE_TIMEOUT_MS,
      'WEB_FETCH_TIMEOUT_MS',
    ),
    userAgent: parseUserAgent(environment['WEB_FETCH_USER_AGENT']),
  });
}

function parseInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseHosts(raw: string | undefined): readonly string[] {
  if (!raw?.trim()) return Object.freeze([]);
  const hosts = raw
    .split(',')
    .map((value) => value.trim().toLowerCase().replace(/^\./u, ''))
    .filter(Boolean);
  if (hosts.some((host) => !isHostnamePattern(host))) {
    throw new Error('WEB_FETCH host policies must contain comma-separated DNS hostnames');
  }
  return Object.freeze([...new Set(hosts)]);
}

function parsePorts(raw: string | undefined): readonly number[] {
  if (!raw?.trim()) return Object.freeze([80, 443]);
  const ports = raw.split(',').map((value) => Number(value.trim()));
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error('WEB_FETCH_ALLOWED_PORTS must contain comma-separated TCP ports');
  }
  return Object.freeze([...new Set(ports)]);
}

function parseUserAgent(raw: string | undefined): string {
  const value = raw?.trim() || 'GEO-Content-OS-WebFetch/1.0';
  if (value.length > 160 || /[\r\n]/u.test(value)) {
    throw new Error('WEB_FETCH_USER_AGENT must contain at most 160 safe characters');
  }
  return value;
}

function isHostnamePattern(value: string): boolean {
  return (
    value.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(
      value,
    )
  );
}
