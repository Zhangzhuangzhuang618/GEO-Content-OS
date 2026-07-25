import type { LoggerService } from '@nestjs/common';
import type { StructuredLogger } from '@geo-content-os/observability';

export class NestStructuredLogger implements LoggerService {
  public constructor(private readonly logger: StructuredLogger) {}

  public log(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.info(toMessage(message), contextAttributes(optionalParameters));
  }

  public fatal(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.error(toMessage(message), undefined, {
      ...contextAttributes(optionalParameters),
      level_override: 'fatal',
    });
  }

  public error(message: unknown, ...optionalParameters: unknown[]): void {
    const error = errorFrom(message, optionalParameters);
    this.logger.error(toMessage(message), error, contextAttributes(optionalParameters));
  }

  public warn(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.warn(toMessage(message), contextAttributes(optionalParameters));
  }

  public debug(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.debug(toMessage(message), contextAttributes(optionalParameters));
  }

  public verbose(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.debug(toMessage(message), {
      ...contextAttributes(optionalParameters),
      level_override: 'verbose',
    });
  }
}

function toMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  return String(value);
}

function contextAttributes(values: readonly unknown[]): Record<string, unknown> {
  const context = [...values].reverse().find((value) => typeof value === 'string');
  return context ? { nest_context: context } : {};
}

function errorFrom(message: unknown, values: readonly unknown[]): Error | undefined {
  if (message instanceof Error) return message;
  const existing = values.find((value): value is Error => value instanceof Error);
  if (existing) return existing;
  const stack = values.find(
    (value): value is string =>
      typeof value === 'string' && value.includes('\n') && /\bat\s+\S+/u.test(value),
  );
  if (!stack) return undefined;
  const error = new Error(toMessage(message));
  error.stack = stack;
  return error;
}
