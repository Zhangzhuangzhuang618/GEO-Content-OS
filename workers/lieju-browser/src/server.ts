import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { z } from 'zod';
import { LiejuBrowserLoginRequestSchema } from '@geo-content-os/contracts';

import { safeBrowserError, toGatewayError } from './service.js';
import type { LiejuBrowserService } from './service.js';

const UuidSchema = z.string().uuid();
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function createGatewayServer(service: LiejuBrowserService, isReady: () => boolean): Server {
  return createServer((request, response) => {
    void route(service, request, response, isReady).catch((error) =>
      sendError(request, response, error),
    );
  });
}

async function route(
  service: LiejuBrowserService,
  request: IncomingMessage,
  response: ServerResponse,
  isReady: () => boolean,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://gateway.local');
  if (request.method === 'GET' && url.pathname === '/health/live') {
    return send(response, 200, { status: 'ok' });
  }
  if (request.method === 'GET' && url.pathname === '/health/ready') {
    return send(response, isReady() ? 200 : 503, { status: isReady() ? 'ok' : 'starting' });
  }
  service.authenticate(header(request, 'authorization'));
  if (request.method === 'GET' && url.pathname === '/capabilities') {
    return send(response, 200, service.capabilities());
  }
  const loginId = sessionRoute(url.pathname, 'login');
  if (request.method === 'POST' && loginId) {
    return send(response, 200, await service.startLogin(loginId, await loginBody(request)), true);
  }
  const reauthId = sessionRoute(url.pathname, 'reauth');
  if (request.method === 'POST' && reauthId) {
    return send(
      response,
      200,
      await service.reauthenticate(reauthId, await loginBody(request)),
      true,
    );
  }
  const sessionId = /^\/sessions\/([^/]+)$/u.exec(url.pathname)?.[1];
  if (request.method === 'GET' && sessionId) {
    return send(response, 200, await service.sessionStatus(requireUuid(sessionId)));
  }
  const accountId = requireAccountId(request, url);
  if (request.method === 'POST' && url.pathname === '/publish') {
    return send(response, 202, await service.publish(accountId, await deliveryBody(request)));
  }
  const statusId = routeParameter(url.pathname, '/status/');
  if (request.method === 'GET' && statusId) {
    return send(response, 200, await service.status(accountId, statusId));
  }
  const metricsId = routeParameter(url.pathname, '/metrics/');
  if (request.method === 'GET' && metricsId) {
    return send(response, 200, await service.metrics(accountId, metricsId));
  }
  return send(response, 404, { code: 'NOT_FOUND', message: 'Route not found' });
}

function requireAccountId(request: IncomingMessage, url: URL): string {
  const value = header(request, 'x-platform-account-id') ?? url.searchParams.get('account_id');
  return requireUuid(value ?? '');
}

function requireUuid(value: string): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error('Platform account id is invalid'), {
      code: 'SCHEMA_INVALID',
      statusCode: 400,
    });
  }
  return parsed.data;
}

function sessionRoute(pathname: string, action: 'login' | 'reauth'): string | null {
  const value = new RegExp(`^/sessions/([^/]+)/${action}$`, 'u').exec(pathname)?.[1];
  return value ? requireUuid(value) : null;
}

function routeParameter(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const value = decodeURIComponent(pathname.slice(prefix.length));
  return value.length >= 1 && value.length <= 240 && !value.includes('/') ? value : null;
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error('Request body is too large'), {
        code: 'PAYLOAD_TOO_LARGE',
        statusCode: 400,
      });
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw Object.assign(new Error('Request body is not valid JSON'), {
      code: 'SCHEMA_INVALID',
      statusCode: 400,
    });
  }
}

async function loginBody(request: IncomingMessage) {
  const contentLength = header(request, 'content-length');
  const transferEncoding = header(request, 'transfer-encoding');
  if (contentLength === '0' || (contentLength === undefined && transferEncoding === undefined)) {
    return LiejuBrowserLoginRequestSchema.parse(undefined);
  }
  const parsed = LiejuBrowserLoginRequestSchema.safeParse(await jsonBody(request));
  if (!parsed.success) {
    throw Object.assign(new Error('Login request is invalid'), {
      code: 'SCHEMA_INVALID',
      statusCode: 400,
    });
  }
  return parsed.data;
}

async function deliveryBody(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  const body = await jsonBody(request);
  const idempotencyKey = header(request, 'idempotency-key');
  if (!body || typeof body !== 'object' || Array.isArray(body) || !idempotencyKey) {
    throw Object.assign(new Error('Publish request is invalid'), {
      code: 'SCHEMA_INVALID',
      statusCode: 400,
    });
  }
  return Object.freeze({
    ...(body as Readonly<Record<string, unknown>>),
    idempotency_key: idempotencyKey,
  });
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function send(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  sensitive = false,
): void {
  response.writeHead(statusCode, {
    'cache-control': sensitive ? 'no-store, private' : 'no-store',
    'content-security-policy': "default-src 'none'",
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function sendError(request: IncomingMessage, response: ServerResponse, error: unknown): void {
  const candidate = error as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly statusCode?: unknown;
  };
  if (typeof candidate.statusCode === 'number' && typeof candidate.code === 'string') {
    logGatewayFailure(request, candidate.statusCode, candidate.code, error);
    send(response, candidate.statusCode, {
      code: candidate.code,
      message: typeof candidate.message === 'string' ? candidate.message : 'Request failed',
    });
    return;
  }
  const gateway = toGatewayError(error);
  logGatewayFailure(request, gateway.statusCode, gateway.code, error);
  send(response, gateway.statusCode, { code: gateway.code, message: gateway.message });
}

function logGatewayFailure(
  request: IncomingMessage,
  statusCode: number,
  code: string,
  error: unknown,
): void {
  if (statusCode < 409) return;
  const pathname = new URL(request.url ?? '/', 'http://gateway.local').pathname;
  const stage = (error as { readonly stage?: unknown } | null)?.stage;
  console.error('Lieju browser gateway request failed', {
    ...(typeof stage === 'string' ? { browser_stage: stage } : {}),
    error: safeBrowserError(error),
    error_code: code,
    http_method: request.method ?? 'UNKNOWN',
    http_path: pathname,
    http_status: statusCode,
  });
}
