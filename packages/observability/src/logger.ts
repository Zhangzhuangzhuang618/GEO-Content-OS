import pino, { type DestinationStream, type Level, type Logger } from 'pino';
import { redactSensitiveData, redactSensitiveText } from '@geo-content-os/security';

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
    this.logger.debug(this.fields(attributes), redactSensitiveText(message));
  }

  public info(message: string, attributes: LogAttributes = {}): void {
    this.logger.info(this.fields(attributes), redactSensitiveText(message));
  }

  public warn(message: string, attributes: LogAttributes = {}): void {
    this.logger.warn(this.fields(attributes), redactSensitiveText(message));
  }

  public error(message: string, error?: unknown, attributes: LogAttributes = {}): void {
    this.logger.error(
      this.fields({
        ...attributes,
        ...(error === undefined ? {} : { error: serializeError(error) }),
      }),
      redactSensitiveText(message),
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
  return redactSensitiveData(value) as Record<string, unknown>;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: redactSensitiveText(error.message),
      name: error.name,
      ...(error.stack ? { stack: redactSensitiveText(error.stack) } : {}),
    };
  }
  return { message: redactSensitiveText(String(error)), name: 'NonErrorThrown' };
}

function normalizeLevel(value: string | undefined): Level {
  const levels: readonly Level[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
  return levels.includes(value as Level) ? (value as Level) : 'info';
}
