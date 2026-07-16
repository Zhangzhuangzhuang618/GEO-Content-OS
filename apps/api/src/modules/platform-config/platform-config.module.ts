import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../common/idempotency/index.js';
import { AuthModule } from '../identity/auth/auth.module.js';
import { RbacModule } from '../identity/rbac/rbac.module.js';
import { PlatformConfigController } from './platform-config.controller.js';
import { PlatformConfigService } from './platform-config.service.js';

@Module({
  controllers: [PlatformConfigController],
  exports: [PlatformConfigService],
  imports: [AuthModule, IdempotencyModule, RbacModule],
  providers: [PlatformConfigService],
})
export class PlatformConfigModule {}
