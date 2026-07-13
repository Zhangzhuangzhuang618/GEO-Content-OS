import { Module } from '@nestjs/common';

import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';

@Module({
  imports: [HealthModule, IdentityModule],
})
export class AppModule {}
