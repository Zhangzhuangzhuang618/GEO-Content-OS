import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '@geo-content-os/security';
import type { FastifyReply } from 'fastify';

const COOKIE_PATH = '/';

export function setSessionCookie(reply: FastifyReply, value: string, ttlSeconds: number): void {
  reply.setCookie(SESSION_COOKIE_NAME, value, {
    expires: new Date(Date.now() + ttlSeconds * 1_000),
    httpOnly: true,
    maxAge: ttlSeconds,
    path: COOKIE_PATH,
    sameSite: 'lax',
    secure: authCookieSecure(),
  });
}

export function setCsrfCookie(reply: FastifyReply, value: string, ttlSeconds: number): void {
  reply.setCookie(CSRF_COOKIE_NAME, value, {
    expires: new Date(Date.now() + ttlSeconds * 1_000),
    httpOnly: false,
    maxAge: ttlSeconds,
    path: COOKIE_PATH,
    sameSite: 'lax',
    secure: authCookieSecure(),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    path: COOKIE_PATH,
    sameSite: 'lax',
    secure: authCookieSecure(),
  });
}

export function clearCsrfCookie(reply: FastifyReply): void {
  reply.clearCookie(CSRF_COOKIE_NAME, {
    httpOnly: false,
    path: COOKIE_PATH,
    sameSite: 'lax',
    secure: authCookieSecure(),
  });
}

export function clearAuthCookies(reply: FastifyReply): void {
  clearSessionCookie(reply);
  clearCsrfCookie(reply);
}

export function authCookieSecure(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment['AUTH_COOKIE_SECURE']?.trim().toLowerCase();
  if (value === undefined || value === '') return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('AUTH_COOKIE_SECURE must be true or false');
}
