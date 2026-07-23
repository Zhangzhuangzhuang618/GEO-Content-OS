import { Module } from '@nestjs/common';

import { AuthModule } from '../../../identity/auth/auth.module.js';
import { RbacModule } from '../../../identity/rbac/rbac.module.js';
import { FactAdjudicationController } from './fact-adjudication.controller.js';
import { FactAdjudicationService } from './fact-adjudication.service.js';

@Module({
  controllers: [FactAdjudicationController],
  exports: [FactAdjudicationService],
  imports: [AuthModule, RbacModule],
  providers: [FactAdjudicationService],
})
export class FactAdjudicationModule {}
