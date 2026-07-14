import { API_BASE_PATH } from '@geo-content-os/contracts';
import { resolveRequestId, type StructuredLogger } from '@geo-content-os/observability';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { LoggerService, LogLevel } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';

import { AppModule } from './app.module.js';
import {
  readApiSecurityConfiguration,
  registerApiSecurityMiddleware,
  type ApiSecurityConfiguration,
} from './common/security/index.js';
import { getApiLogger } from './common/telemetry/api-logger.js';
import { NestStructuredLogger } from './common/telemetry/nest-logger.js';
import { registerRequestTelemetry } from './common/telemetry/request-telemetry.js';

export interface CreateApplicationOptions {
  readonly enableShutdownHooks?: boolean;
  readonly logger?: LoggerService | LogLevel[] | false;
  readonly telemetryLogger?: StructuredLogger | false;
  readonly securityConfiguration?: ApiSecurityConfiguration;
}

export async function createApplication(
  options: CreateApplicationOptions = {},
): Promise<NestFastifyApplication> {
  const telemetryLogger = resolveTelemetryLogger(options);
  const securityConfiguration =
    options.securityConfiguration ?? readApiSecurityConfiguration(process.env);
  const application = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      genReqId: (request: IncomingMessage | Http2ServerRequest) =>
        resolveRequestId(request.headers['x-request-id']),
      trustProxy: securityConfiguration.trustProxy,
    }),
    {
      abortOnError: false,
      logger:
        options.logger ?? (telemetryLogger ? new NestStructuredLogger(telemetryLogger) : false),
    },
  );

  application.setGlobalPrefix(API_BASE_PATH.slice(1));
  registerRequestTelemetry(application.getHttpAdapter().getInstance(), telemetryLogger);
  await registerApiSecurityMiddleware(application, securityConfiguration);

  if (options.enableShutdownHooks !== false) {
    application.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  }

  return application;
}

function resolveTelemetryLogger(options: CreateApplicationOptions): StructuredLogger | undefined {
  if (options.telemetryLogger === false) return undefined;
  if (options.telemetryLogger) return options.telemetryLogger;
  if (options.logger === false) return undefined;
  return getApiLogger();
}
