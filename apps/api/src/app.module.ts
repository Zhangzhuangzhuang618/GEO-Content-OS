import { Module } from '@nestjs/common';

import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { PlatformAccessModule } from './modules/platform-access/platform-access.module.js';

@Module({
  imports: [HealthModule, IdentityModule, PlatformAccessModule],
})
export class AppModule {}
