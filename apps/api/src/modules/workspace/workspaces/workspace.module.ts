import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../../identity/auth/auth.module.js';
import { RbacModule } from '../../identity/rbac/rbac.module.js';
import { WorkspaceController } from './workspace.controller.js';
import { WorkspaceService } from './workspace.service.js';

@Module({
  controllers: [WorkspaceController],
  exports: [WorkspaceService],
  imports: [AuthModule, IdempotencyModule, RbacModule],
  providers: [WorkspaceService],
})
export class WorkspaceModule {}
