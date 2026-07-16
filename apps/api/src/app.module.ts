import { Module } from '@nestjs/common';

import { AnalyticsApiModule } from './modules/analytics/index.js';
import { BriefModule, ContentApiModule } from './modules/content/index.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { FactAdjudicationModule, SourceModule } from './modules/knowledge/index.js';
import { PlatformAccessModule } from './modules/platform-access/platform-access.module.js';
import { PlatformConfigModule } from './modules/platform-config/index.js';
import { PublishingModule } from './modules/publishing/index.js';
import { ReviewApiModule } from './modules/review/index.js';
import { TenantLifecycleModule } from './modules/tenant-lifecycle/index.js';
import {
  BrandProfileModule,
  KeywordModule,
  ProjectModule,
  TopicModule,
  WorkspaceModule,
} from './modules/workspace/index.js';

@Module({
  imports: [
    AnalyticsApiModule,
    BrandProfileModule,
    BriefModule,
    ContentApiModule,
    FactAdjudicationModule,
    HealthModule,
    IdentityModule,
    KeywordModule,
    PlatformAccessModule,
    PlatformConfigModule,
    ProjectModule,
    PublishingModule,
    ReviewApiModule,
    SourceModule,
    TenantLifecycleModule,
    TopicModule,
    WorkspaceModule,
  ],
})
export class AppModule {}
