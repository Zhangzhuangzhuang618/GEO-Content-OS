import { Module } from '@nestjs/common';

import { AuthModule } from '../identity/auth/auth.module.js';
import { RbacModule } from '../identity/rbac/rbac.module.js';
import { AuditQueryController } from './audit-query.controller.js';
import { AuditQueryService } from './audit-query.service.js';

@Module({
  controllers: [AuditQueryController],
  exports: [AuditQueryService],
  imports: [AuthModule, RbacModule],
  providers: [AuditQueryService],
})
export class AuditQueryModule {}
