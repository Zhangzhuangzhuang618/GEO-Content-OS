import { ERROR_DEFINITIONS } from '@geo-content-os/contracts';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '@geo-content-os/security';
import { Body, Controller, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { clearAuthCookies } from '../auth/auth.cookies.js';
import { AuthService } from '../auth/auth.service.js';
import {
  ChangePasswordRequestSchema,
  ForgotPasswordRequestSchema,
  ResetPasswordRequestSchema,
} from './password.dto.js';
import { PasswordService } from './password.service.js';

@Controller('auth/password')
export class PasswordController {
  public constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(PasswordService) private readonly passwordService: PasswordService,
  ) {}

  @Post('forgot')
  public async forgot(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = ForgotPasswordRequestSchema.safeParse(body);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    await this.passwordService.requestReset(parsed.data.email);
    await reply.status(HttpStatus.ACCEPTED).send();
  }

  @Post('reset')
  public async reset(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = ResetPasswordRequestSchema.safeParse(body);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const reset = await this.passwordService.resetPassword(
      parsed.data.token,
      parsed.data.new_password,
    );
    if (!reset) {
      await sendError(reply, request.id, 'RESOURCE_NOT_FOUND');
      return;
    }
    clearAuthCookies(reply);
    await reply.status(HttpStatus.NO_CONTENT).send();
  }

  @Post('change')
  public async change(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = ChangePasswordRequestSchema.safeParse(body);
    if (!parsed.success) {
      await sendSchemaError(reply, request.id, parsed.error.issues);
      return;
    }
    const session = await this.authService.authenticateWriteSession(
      request.cookies[SESSION_COOKIE_NAME],
      request.cookies[CSRF_COOKIE_NAME],
    );
    if (!session) {
      clearAuthCookies(reply);
      await sendError(reply, request.id, 'AUTH_REQUIRED');
      return;
    }
    const changed = await this.passwordService.changePassword(
      session.userId,
      parsed.data.current_password,
      parsed.data.new_password,
    );
    if (!changed) {
      await sendError(reply, request.id, 'AUTH_REQUIRED');
      return;
    }
    clearAuthCookies(reply);
    await reply.status(HttpStatus.NO_CONTENT).send();
  }
}

async function sendSchemaError(
  reply: FastifyReply,
  requestId: string,
  issues: readonly { readonly code: string; readonly path: PropertyKey[] }[],
): Promise<void> {
  await reply.status(HttpStatus.UNPROCESSABLE_ENTITY).send({
    error: {
      code: 'SCHEMA_VALIDATION_FAILED',
      details: { issues: issues.map((issue) => ({ code: issue.code, path: issue.path })) },
      message: ERROR_DEFINITIONS.SCHEMA_VALIDATION_FAILED.message,
      request_id: requestId,
    },
  });
}

async function sendError(
  reply: FastifyReply,
  requestId: string,
  code: 'AUTH_REQUIRED' | 'RESOURCE_NOT_FOUND',
): Promise<void> {
  await reply.status(ERROR_DEFINITIONS[code].httpStatus).send({
    error: {
      code,
      message: ERROR_DEFINITIONS[code].message,
      request_id: requestId,
    },
  });
}
