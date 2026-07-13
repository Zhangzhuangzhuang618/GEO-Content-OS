import { ERROR_DEFINITIONS } from '@geo-content-os/contracts';
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  generateSecureToken,
  isValidCsrfToken,
} from '@geo-content-os/security';
import { Body, Controller, Get, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { LoginRequestSchema, type SessionView } from './auth.dto.js';
import { AuthService } from './auth.service.js';

const COOKIE_PATH = '/';

@Controller('auth')
export class AuthController {
  public constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post('login')
  public async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      await sendError(
        reply,
        request.id,
        'SCHEMA_VALIDATION_FAILED',
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          issues: parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path })),
        },
      );
      return;
    }

    const result = await this.authService.login(parsed.data, {
      ip: request.ip,
      ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
    });
    if (!result) {
      await sendAuthRequired(reply, request.id);
      return;
    }

    setSessionCookie(reply, result.sessionToken, result.ttlSeconds);
    setCsrfCookie(reply, result.csrfToken, result.ttlSeconds);
    await sendSession(reply, request.id, result.view);
  }

  @Get('session')
  public async session(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const result = await this.authService.getSession(
      request.cookies[SESSION_COOKIE_NAME],
      request.cookies[CSRF_COOKIE_NAME],
    );
    if (!result) {
      clearSessionCookie(reply);
      ensurePreAuthCsrfCookie(request, reply, this.authService.preAuthCsrfTtlSeconds);
      await sendAuthRequired(reply, request.id);
      return;
    }

    if (result.csrfToken) {
      const ttlSeconds = Math.max(
        1,
        Math.floor((new Date(result.view.expires_at).getTime() - Date.now()) / 1_000),
      );
      setCsrfCookie(reply, result.csrfToken, ttlSeconds);
    }
    await sendSession(reply, request.id, result.view);
  }

  @Post('logout')
  public async logout(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const revoked = await this.authService.logout(
      request.cookies[SESSION_COOKIE_NAME],
      request.cookies[CSRF_COOKIE_NAME],
    );
    if (!revoked) {
      clearSessionCookie(reply);
      clearCsrfCookie(reply);
      await sendAuthRequired(reply, request.id);
      return;
    }

    clearSessionCookie(reply);
    clearCsrfCookie(reply);
    await reply.status(HttpStatus.NO_CONTENT).send();
  }
}

function setSessionCookie(reply: FastifyReply, value: string, ttlSeconds: number): void {
  reply.setCookie(SESSION_COOKIE_NAME, value, {
    expires: new Date(Date.now() + ttlSeconds * 1_000),
    httpOnly: true,
    maxAge: ttlSeconds,
    path: COOKIE_PATH,
    sameSite: 'lax',
    secure: true,
  });
}

function setCsrfCookie(reply: FastifyReply, value: string, ttlSeconds: number): void {
  reply.setCookie(CSRF_COOKIE_NAME, value, {
    expires: new Date(Date.now() + ttlSeconds * 1_000),
    httpOnly: false,
    maxAge: ttlSeconds,
    path: COOKIE_PATH,
    sameSite: 'lax',
    secure: true,
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    path: COOKIE_PATH,
    sameSite: 'lax',
    secure: true,
  });
}

function clearCsrfCookie(reply: FastifyReply): void {
  reply.clearCookie(CSRF_COOKIE_NAME, {
    httpOnly: false,
    path: COOKIE_PATH,
    sameSite: 'lax',
    secure: true,
  });
}

function ensurePreAuthCsrfCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  ttlSeconds: number,
): void {
  if (isValidCsrfToken(request.cookies[CSRF_COOKIE_NAME])) return;
  setCsrfCookie(reply, generateSecureToken(32), ttlSeconds);
}

async function sendSession(
  reply: FastifyReply,
  requestId: string,
  session: SessionView,
): Promise<void> {
  await reply.status(HttpStatus.OK).send({ data: session, meta: { request_id: requestId } });
}

async function sendAuthRequired(reply: FastifyReply, requestId: string): Promise<void> {
  await sendError(reply, requestId, 'AUTH_REQUIRED', ERROR_DEFINITIONS.AUTH_REQUIRED.httpStatus);
}

async function sendError(
  reply: FastifyReply,
  requestId: string,
  code: 'AUTH_REQUIRED' | 'SCHEMA_VALIDATION_FAILED',
  status: number,
  details?: unknown,
): Promise<void> {
  await reply.status(status).send({
    error: {
      code,
      ...(details === undefined ? {} : { details }),
      message: ERROR_DEFINITIONS[code].message,
      request_id: requestId,
    },
  });
}
