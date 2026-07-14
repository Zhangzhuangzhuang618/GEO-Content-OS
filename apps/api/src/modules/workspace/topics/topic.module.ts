import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../../identity/auth/auth.module.js';
import { RbacModule } from '../../identity/rbac/rbac.module.js';
import { OutboxModule } from '../../outbox/index.js';
import { TopicCandidateController, TopicPlanController } from './topic.controller.js';
import { TopicService } from './topic.service.js';

@Module({
  controllers: [TopicPlanController, TopicCandidateController],
  exports: [TopicService],
  imports: [AuthModule, IdempotencyModule, OutboxModule, RbacModule],
  providers: [TopicService],
})
export class TopicModule {}
