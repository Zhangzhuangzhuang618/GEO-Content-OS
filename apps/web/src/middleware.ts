import {
  CSRF_COOKIE_NAME,
  createWebSecurityHeaders,
  generateSecureToken,
  isValidCsrfToken,
} from '@geo-content-os/security';
import { type NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest): NextResponse {
  const nonce = generateSecureToken();
  const apiOrigin = normalizeOptionalOrigin(process.env['NEXT_PUBLIC_API_ORIGIN']);
  const securityHeaders = createWebSecurityHeaders({
    ...(apiOrigin ? { connectOrigins: [apiOrigin] } : {}),
    nonce,
    production: process.env['NODE_ENV'] === 'production',
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', securityHeaders['Content-Security-Policy']!);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value);
  response.headers.set('Cache-Control', 'no-store');

  if (!isValidCsrfToken(request.cookies.get(CSRF_COOKIE_NAME)?.value)) {
    response.cookies.set({
      httpOnly: false,
      name: CSRF_COOKIE_NAME,
      path: '/',
      sameSite: 'lax',
      secure: request.nextUrl.protocol === 'https:',
      value: generateSecureToken(),
    });
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};

function normalizeOptionalOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== value.trim().replace(/\/$/u, '')
  ) {
    throw new Error('NEXT_PUBLIC_API_ORIGIN must be an HTTP(S) origin without a path');
  }
  return url.origin;
}
