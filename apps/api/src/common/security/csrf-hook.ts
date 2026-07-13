import { ERROR_DEFINITIONS } from '@geo-content-os/contracts';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  validateDoubleSubmitCsrf,
} from '@geo-content-os/security';
import type { FastifyInstance } from 'fastify';

export function registerCsrfHook(server: FastifyInstance): void {
  server.addHook('onRequest', async (request, reply) => {
    const result = validateDoubleSubmitCsrf({
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(request.cookies[CSRF_COOKIE_NAME]
        ? { cookieToken: request.cookies[CSRF_COOKIE_NAME] }
        : {}),
      ...(request.headers[CSRF_HEADER_NAME]
        ? { headerToken: request.headers[CSRF_HEADER_NAME] }
        : {}),
      method: request.method,
      sessionCookiePresent: Boolean(request.cookies[SESSION_COOKIE_NAME]),
    });
    if (!result.required || result.valid) return;

    await reply.code(ERROR_DEFINITIONS.CSRF_INVALID.httpStatus).send({
      error: {
        code: 'CSRF_INVALID',
        message: ERROR_DEFINITIONS.CSRF_INVALID.message,
        request_id: request.id,
      },
    });
  });
}
