import { Module } from '@nestjs/common';

import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { PlatformAccessModule } from './modules/platform-access/platform-access.module.js';
import {
  BrandProfileModule,
  KeywordModule,
  ProjectModule,
  WorkspaceModule,
} from './modules/workspace/index.js';

@Module({
  imports: [
    BrandProfileModule,
    HealthModule,
    IdentityModule,
    KeywordModule,
    PlatformAccessModule,
    ProjectModule,
    WorkspaceModule,
  ],
})
export class AppModule {}
