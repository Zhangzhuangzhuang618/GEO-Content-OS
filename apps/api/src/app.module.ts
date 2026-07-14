import { Module } from '@nestjs/common';

import { BriefModule } from './modules/content/index.js';
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
    BriefModule,
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
