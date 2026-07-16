import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { IdentityEmailModule } from '../email/email.module.js';
import { InvitationController } from './invitation.controller.js';
import { InvitationService } from './invitation.service.js';

@Module({
  controllers: [InvitationController],
  exports: [InvitationService],
  imports: [AuthModule, IdempotencyModule, IdentityEmailModule, RbacModule],
  providers: [InvitationService],
})
export class InvitationModule {}
