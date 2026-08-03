import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../../identity/auth/auth.module.js';
import { RbacModule } from '../../identity/rbac/rbac.module.js';
import { KeywordController } from './keyword.controller.js';
import { KeywordImportService } from './keyword-import.service.js';
import { KeywordService } from './keyword.service.js';
import { OutboxModule } from '../../outbox/index.js';

@Module({
  controllers: [KeywordController],
  exports: [KeywordService],
  imports: [AuthModule, IdempotencyModule, OutboxModule, RbacModule],
  providers: [KeywordImportService, KeywordService],
})
export class KeywordModule {}
