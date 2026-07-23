import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../../identity/auth/auth.module.js';
import { RbacModule } from '../../identity/rbac/rbac.module.js';
import { ProjectController } from './project.controller.js';
import { ProjectService } from './project.service.js';

@Module({
  controllers: [ProjectController],
  exports: [ProjectService],
  imports: [AuthModule, IdempotencyModule, RbacModule],
  providers: [ProjectService],
})
export class ProjectModule {}
