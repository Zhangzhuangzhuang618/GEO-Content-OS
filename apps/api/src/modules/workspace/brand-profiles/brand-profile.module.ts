import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../../identity/auth/auth.module.js';
import { RbacModule } from '../../identity/rbac/rbac.module.js';
import { BrandProfileController } from './brand-profile.controller.js';
import { BrandProfileService } from './brand-profile.service.js';

@Module({
  controllers: [BrandProfileController],
  exports: [BrandProfileService],
  imports: [AuthModule, IdempotencyModule, RbacModule],
  providers: [BrandProfileService],
})
export class BrandProfileModule {}
