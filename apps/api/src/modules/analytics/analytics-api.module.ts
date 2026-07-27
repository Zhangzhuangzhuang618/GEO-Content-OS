import { createStorageAdapter, readStorageConfiguration } from '@geo-content-os/adapter-storage';
import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../common/idempotency/idempotency.module.js';
import { CostQueryService } from '../billing/costs/index.js';
import { IdentityAuthDatabase } from '../identity/auth/auth.database.js';
import { AuthModule } from '../identity/auth/auth.module.js';
import { RbacModule } from '../identity/rbac/rbac.module.js';
import { OutboxModule, OutboxWriter } from '../outbox/index.js';
import { AnalyticsApiController } from './analytics-api.controller.js';
import { AiVisibilityService } from './ai-visibility/index.js';
import { AnalyticsApiService } from './analytics-api.service.js';
import { ANALYTICS_STORAGE } from './analytics.tokens.js';
import { MetricsImportService } from './imports/index.js';
import { AnalyticsQueryService } from './queries/index.js';
import { MetricRegistry } from './repositories/index.js';
import { VisibilityService } from './visibility/index.js';

@Module({
  controllers: [AnalyticsApiController],
  exports: [AnalyticsApiService],
  imports: [AuthModule, IdempotencyModule, OutboxModule, RbacModule],
  providers: [
    {
      provide: ANALYTICS_STORAGE,
      useFactory: () => createStorageAdapter(readStorageConfiguration()),
    },
    {
      provide: MetricRegistry,
      useFactory: () =>
        new MetricRegistry([
          { aggregation: 'sum', allowNegative: false, name: 'conversions', unit: 'count' },
          { aggregation: 'sum', allowNegative: false, name: 'engagements', unit: 'count' },
          { aggregation: 'sum', allowNegative: false, name: 'exposures', unit: 'count' },
          { aggregation: 'sum', allowNegative: false, name: 'reads', unit: 'count' },
        ]),
    },
    {
      provide: AnalyticsQueryService,
      inject: [IdentityAuthDatabase, MetricRegistry],
      useFactory: (database: IdentityAuthDatabase, registry: MetricRegistry) =>
        new AnalyticsQueryService(database, registry, undefined, {
          cacheTtlSeconds: 60,
          methodologyVersion: 'analytics@1',
        }),
    },
    {
      provide: CostQueryService,
      inject: [IdentityAuthDatabase],
      useFactory: (database: IdentityAuthDatabase) => new CostQueryService(database),
    },
    {
      provide: MetricsImportService,
      inject: [OutboxWriter, MetricRegistry],
      useFactory: (outbox: OutboxWriter, registry: MetricRegistry) =>
        new MetricsImportService(outbox, registry),
    },
    {
      provide: VisibilityService,
      inject: [IdentityAuthDatabase, ANALYTICS_STORAGE],
      useFactory: (
        database: IdentityAuthDatabase,
        storage: ReturnType<typeof createStorageAdapter>,
      ) => new VisibilityService(database, storage),
    },
    {
      provide: AiVisibilityService,
      inject: [IdentityAuthDatabase, OutboxWriter],
      useFactory: (database: IdentityAuthDatabase, outbox: OutboxWriter) =>
        new AiVisibilityService(database, outbox),
    },
    {
      provide: AnalyticsApiService,
      inject: [IdentityAuthDatabase, OutboxWriter],
      useFactory: (database: IdentityAuthDatabase, outbox: OutboxWriter) =>
        new AnalyticsApiService(database, outbox),
    },
  ],
})
export class AnalyticsApiModule {}
