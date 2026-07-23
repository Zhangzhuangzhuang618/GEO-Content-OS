import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../identity/auth/auth.module.js';
import { RbacModule } from '../identity/rbac/rbac.module.js';
import { SupportAccessController } from './support-access.controller.js';
import { SupportAccessService } from './support-access.service.js';

@Module({
  controllers: [SupportAccessController],
  exports: [SupportAccessService],
  imports: [AuthModule, IdempotencyModule, RbacModule],
  providers: [SupportAccessService],
})
export class PlatformAccessModule {}
