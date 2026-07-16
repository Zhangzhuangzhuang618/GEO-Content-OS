import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/index.js';
import { AuthModule } from '../auth/auth.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { TenantController } from './tenant.controller.js';
import { TenantService } from './tenant.service.js';

@Module({
  controllers: [TenantController],
  exports: [TenantService],
  imports: [AuthModule, IdempotencyModule, RbacModule],
  providers: [TenantService],
})
export class TenantModule {}
