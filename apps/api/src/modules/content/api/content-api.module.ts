import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../../identity/auth/auth.module.js';
import { RbacModule } from '../../identity/rbac/rbac.module.js';
import { OutboxModule } from '../../outbox/index.js';
import {
  ContentPackageController,
  ContentVariantController,
  ContentVersionController,
  GenerationRunController,
} from './content-api.controller.js';
import { ContentApiService } from './content-api.service.js';

@Module({
  controllers: [
    ContentPackageController,
    GenerationRunController,
    ContentVersionController,
    ContentVariantController,
  ],
  exports: [ContentApiService],
  imports: [AuthModule, IdempotencyModule, OutboxModule, RbacModule],
  providers: [ContentApiService],
})
export class ContentApiModule {}
