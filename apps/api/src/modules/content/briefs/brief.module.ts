import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../../identity/auth/auth.module.js';
import { RbacModule } from '../../identity/rbac/rbac.module.js';
import { BriefCostEstimator } from './brief-cost-estimator.js';
import { BriefController } from './brief.controller.js';
import { BriefService } from './brief.service.js';

@Module({
  controllers: [BriefController],
  exports: [BriefCostEstimator, BriefService],
  imports: [AuthModule, IdempotencyModule, RbacModule],
  providers: [BriefCostEstimator, BriefService],
})
export class BriefModule {}
