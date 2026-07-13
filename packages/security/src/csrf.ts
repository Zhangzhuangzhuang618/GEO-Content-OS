export const CSRF_COOKIE_NAME = 'geo_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const SESSION_COOKIE_NAME = 'geo_session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

export interface CsrfValidationInput {
  readonly method: string;
  readonly cookieToken?: string;
  readonly headerToken?: string | readonly string[];
  readonly authorization?: string;
  readonly sessionCookiePresent?: boolean;
}

export type CsrfValidationResult =
  | { readonly required: false; readonly valid: true }
  | { readonly required: true; readonly valid: boolean };

export function generateSecureToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64) {
    throw new RangeError('Secure token size must be an integer between 16 and 64 bytes');
  }
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return toBase64Url(buffer);
}

export function isValidCsrfToken(value: string | undefined): value is string {
  return Boolean(value && TOKEN_PATTERN.test(value));
}

export function validateDoubleSubmitCsrf(input: CsrfValidationInput): CsrfValidationResult {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { required: false, valid: true };

  const bearerRequest = /^Bearer\s+\S+$/iu.test(input.authorization?.trim() ?? '');
  if (bearerRequest && !input.sessionCookiePresent) return { required: false, valid: true };

  const headerToken = typeof input.headerToken === 'string' ? input.headerToken : undefined;
  return {
    required: true,
    valid:
      isValidCsrfToken(input.cookieToken) &&
      isValidCsrfToken(headerToken) &&
      constantTimeEqual(input.cookieToken, headerToken),
  };
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
