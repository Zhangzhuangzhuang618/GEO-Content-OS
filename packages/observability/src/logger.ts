import pino, { type DestinationStream, type Level, type Logger } from 'pino';

import { getTelemetryContext } from './context.js';

export type LogAttributes = Readonly<Record<string, unknown>>;

export interface StructuredLoggerOptions {
  readonly service: string;
  readonly environment?: string;
  readonly level?: Level;
  readonly destination?: DestinationStream;
  readonly base?: LogAttributes;
}

export interface StructuredLogger {
  debug(message: string, attributes?: LogAttributes): void;
  info(message: string, attributes?: LogAttributes): void;
  warn(message: string, attributes?: LogAttributes): void;
  error(message: string, error?: unknown, attributes?: LogAttributes): void;
  child(bindings: LogAttributes): StructuredLogger;
}

const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token|api[_-]?key/iu;

export function createStructuredLogger(options: StructuredLoggerOptions): StructuredLogger {
  const base = {
    environment: options.environment ?? process.env['NODE_ENV'] ?? 'development',
    service: options.service,
    ...sanitizeAttributes(options.base ?? {}),
  };
  const logger = pino(
    {
      base,
      level: options.level ?? normalizeLevel(process.env['LOG_LEVEL']),
      messageKey: 'message',
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination,
  );
  return new PinoStructuredLogger(logger, {});
}

export function createNullLogger(): StructuredLogger {
  return {
    child: () => createNullLogger(),
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
}

class PinoStructuredLogger implements StructuredLogger {
  public constructor(
    private readonly logger: Logger,
    private readonly bindings: LogAttributes,
  ) {}

  public debug(message: string, attributes: LogAttributes = {}): void {
    this.logger.debug(this.fields(attributes), redactText(message));
  }

  public info(message: string, attributes: LogAttributes = {}): void {
    this.logger.info(this.fields(attributes), redactText(message));
  }

  public warn(message: string, attributes: LogAttributes = {}): void {
    this.logger.warn(this.fields(attributes), redactText(message));
  }

  public error(message: string, error?: unknown, attributes: LogAttributes = {}): void {
    this.logger.error(
      this.fields({
        ...attributes,
        ...(error === undefined ? {} : { error: serializeError(error) }),
      }),
      redactText(message),
    );
  }

  public child(bindings: LogAttributes): StructuredLogger {
    return new PinoStructuredLogger(this.logger, {
      ...this.bindings,
      ...sanitizeAttributes(bindings),
    });
  }

  private fields(attributes: LogAttributes): Record<string, unknown> {
    const telemetry = getTelemetryContext();
    return {
      ...this.bindings,
      ...(telemetry.requestId ? { request_id: telemetry.requestId } : {}),
      ...(telemetry.tenantId ? { tenant_id: telemetry.tenantId } : {}),
      ...(telemetry.userId ? { user_id: telemetry.userId } : {}),
      ...(telemetry.jobId ? { job_id: telemetry.jobId } : {}),
      ...(telemetry.runId ? { run_id: telemetry.runId } : {}),
      ...(telemetry.traceId ? { trace_id: telemetry.traceId } : {}),
      ...(telemetry.spanId ? { span_id: telemetry.spanId } : {}),
      ...sanitizeAttributes(attributes),
    };
  }
}

export function sanitizeAttributes(value: LogAttributes): Record<string, unknown> {
  return sanitizeRecord(value, new WeakSet<object>());
}

function sanitizeRecord(
  value: Readonly<Record<string, unknown>>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  if (seen.has(value)) return { circular: '[Circular]' };
  seen.add(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeValue(item, seen),
    ]),
  );
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
  if (value === undefined) return undefined;
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => sanitizeValue(item, seen));
  }
  if (typeof value === 'object') {
    return sanitizeRecord(value as Readonly<Record<string, unknown>>, seen);
  }
  return String(value);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: redactText(error.message),
      name: error.name,
      ...(error.stack ? { stack: redactText(error.stack) } : {}),
    };
  }
  return { message: redactText(String(error)), name: 'NonErrorThrown' };
}

function redactText(value: string): string {
  return value
    .replaceAll(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replaceAll(/((?:api[_-]?key|password|secret|token)=)[^&\s]+/giu, '$1[REDACTED]');
}

function normalizeLevel(value: string | undefined): Level {
  const levels: readonly Level[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
  return levels.includes(value as Level) ? (value as Level) : 'info';
}
