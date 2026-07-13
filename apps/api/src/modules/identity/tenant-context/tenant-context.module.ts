import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { TenantContextController } from './tenant-context.controller.js';
import { TenantContextService } from './tenant-context.service.js';

@Module({
  controllers: [TenantContextController],
  exports: [TenantContextService],
  imports: [AuthModule, IdempotencyModule],
  providers: [TenantContextService],
})
export class TenantContextModule {}
