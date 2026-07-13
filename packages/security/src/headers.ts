export interface WebSecurityHeaderOptions {
  readonly nonce: string;
  readonly production: boolean;
  readonly connectOrigins?: readonly string[];
}

export interface ApiSecurityHeaderOptions {
  readonly production: boolean;
}

export function createWebSecurityHeaders(
  options: WebSecurityHeaderOptions,
): Readonly<Record<string, string>> {
  const csp = buildContentSecurityPolicy({
    ...(options.connectOrigins ? { connectOrigins: options.connectOrigins } : {}),
    nonce: options.nonce,
    production: options.production,
  });

  return Object.freeze({
    'Content-Security-Policy': csp,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Permitted-Cross-Domain-Policies': 'none',
    ...(options.production
      ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload' }
      : {}),
  });
}

export function createApiContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

export function createApiSecurityHeaders(
  options: ApiSecurityHeaderOptions,
): Readonly<Record<string, string>> {
  return Object.freeze({
    'Content-Security-Policy': createApiContentSecurityPolicy(),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Permitted-Cross-Domain-Policies': 'none',
    ...(options.production
      ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload' }
      : {}),
  });
}

function buildContentSecurityPolicy(options: WebSecurityHeaderOptions): string {
  if (!/^[A-Za-z0-9_-]{20,128}$/u.test(options.nonce)) {
    throw new Error('CSP nonce has an invalid format');
  }
  const connectSources = ["'self'", ...(options.connectOrigins ?? [])];
  const scriptSources = [
    "'self'",
    `'nonce-${options.nonce}'`,
    "'strict-dynamic'",
    ...(options.production ? [] : ["'unsafe-eval'"]),
  ];
  const styleSources = ["'self'", `'nonce-${options.nonce}'`];
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    `connect-src ${connectSources.join(' ')}`,
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    `script-src ${scriptSources.join(' ')}`,
    `style-src ${styleSources.join(' ')}`,
    "worker-src 'self' blob:",
    ...(options.production ? ['upgrade-insecure-requests'] : []),
  ];
  return directives.join('; ');
}
