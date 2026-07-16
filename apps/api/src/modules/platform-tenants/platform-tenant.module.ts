import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../common/idempotency/index.js';
import { AuthModule } from '../identity/auth/auth.module.js';
import { IdentityEmailModule } from '../identity/email/email.module.js';
import { RbacModule } from '../identity/rbac/rbac.module.js';
import { PlatformTenantController } from './platform-tenant.controller.js';
import { PlatformTenantService } from './platform-tenant.service.js';

@Module({
  controllers: [PlatformTenantController],
  exports: [PlatformTenantService],
  imports: [AuthModule, IdempotencyModule, IdentityEmailModule, RbacModule],
  providers: [PlatformTenantService],
})
export class PlatformTenantModule {}
