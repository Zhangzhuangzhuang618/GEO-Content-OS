import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../common/idempotency/idempotency.module.js';
import { IdentityAuthDatabase } from '../identity/auth/auth.database.js';
import { AuthModule } from '../identity/auth/auth.module.js';
import { RbacModule } from '../identity/rbac/rbac.module.js';
import { OutboxModule, OutboxWriter } from '../outbox/index.js';
import { TenantLifecycleController } from './tenant-lifecycle.controller.js';
import { TenantLifecycleService } from './tenant-lifecycle.service.js';

@Module({
  controllers: [TenantLifecycleController],
  exports: [TenantLifecycleService],
  imports: [AuthModule, IdempotencyModule, OutboxModule, RbacModule],
  providers: [
    {
      provide: TenantLifecycleService,
      inject: [IdentityAuthDatabase, OutboxWriter],
      useFactory: (database: IdentityAuthDatabase, outbox: OutboxWriter) =>
        new TenantLifecycleService(database, outbox),
    },
  ],
})
export class TenantLifecycleModule {}
