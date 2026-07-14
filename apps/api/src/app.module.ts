import { Module } from '@nestjs/common';

import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { FactAdjudicationModule, SourceModule } from './modules/knowledge/index.js';
import { PlatformAccessModule } from './modules/platform-access/platform-access.module.js';
import {
  BrandProfileModule,
  KeywordModule,
  ProjectModule,
  TopicModule,
  WorkspaceModule,
} from './modules/workspace/index.js';

@Module({
  imports: [
    BrandProfileModule,
    FactAdjudicationModule,
    HealthModule,
    IdentityModule,
    KeywordModule,
    PlatformAccessModule,
    ProjectModule,
    SourceModule,
    TopicModule,
    WorkspaceModule,
  ],
})
export class AppModule {}
