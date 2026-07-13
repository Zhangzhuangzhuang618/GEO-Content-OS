import { createStructuredLogger, type StructuredLogger } from '@geo-content-os/observability';

let logger: StructuredLogger | undefined;

export function getApiLogger(): StructuredLogger {
  logger ??= createStructuredLogger({ service: 'api' });
  return logger;
}
