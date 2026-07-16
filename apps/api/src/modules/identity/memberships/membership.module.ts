import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { MembershipController } from './membership.controller.js';
import { MembershipService } from './membership.service.js';

@Module({
  controllers: [MembershipController],
  exports: [MembershipService],
  imports: [AuthModule, IdempotencyModule, RbacModule],
  providers: [MembershipService],
})
export class MembershipModule {}
