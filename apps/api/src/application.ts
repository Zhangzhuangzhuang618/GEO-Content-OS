import { API_BASE_PATH } from '@geo-content-os/contracts';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { LoggerService, LogLevel } from '@nestjs/common';

import { AppModule } from './app.module.js';

export interface CreateApplicationOptions {
  readonly enableShutdownHooks?: boolean;
  readonly logger?: LoggerService | LogLevel[] | false;
}

export async function createApplication(
  options: CreateApplicationOptions = {},
): Promise<NestFastifyApplication> {
  const application = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    {
      logger: options.logger ?? ['error', 'warn', 'log'],
    },
  );

  application.setGlobalPrefix(API_BASE_PATH.slice(1));

  if (options.enableShutdownHooks !== false) {
    application.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  }

  return application;
}
