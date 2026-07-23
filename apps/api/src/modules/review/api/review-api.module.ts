import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../../identity/auth/auth.module.js';
import { RbacModule } from '../../identity/rbac/rbac.module.js';
import { ReviewSnapshotController, ReviewSubmissionController } from './review-api.controller.js';
import { ReviewApiService } from './review-api.service.js';

@Module({
  controllers: [ReviewSubmissionController, ReviewSnapshotController],
  exports: [ReviewApiService],
  imports: [AuthModule, IdempotencyModule, RbacModule],
  providers: [ReviewApiService],
})
export class ReviewApiModule {}
