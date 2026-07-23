import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { HealthService, type HealthCheck } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get('live')
  liveness(@Res({ passthrough: true }) response: FastifyReply): HealthCheck {
    response.header('Cache-Control', 'no-store');
    return this.healthService.liveness();
  }

  @Get('ready')
  readiness(@Res({ passthrough: true }) response: FastifyReply): HealthCheck {
    const check = this.healthService.readiness();
    response.header('Cache-Control', 'no-store');

    if (check.status !== 'ok') {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return check;
  }
}
