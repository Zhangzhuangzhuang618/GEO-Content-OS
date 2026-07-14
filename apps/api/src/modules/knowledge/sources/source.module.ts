import { createStorageAdapter, readStorageConfiguration } from '@geo-content-os/adapter-storage';
import { readWebFetchConfiguration, SafeWebFetchAdapter } from '@geo-content-os/adapter-web-fetch';
import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { AuthModule } from '../../identity/auth/auth.module.js';
import { RbacModule } from '../../identity/rbac/rbac.module.js';
import { OutboxModule } from '../../outbox/index.js';
import {
  IngestJobController,
  KnowledgeFactController,
  KnowledgeSourceController,
} from '../knowledge-api.controller.js';
import { KnowledgeApiService } from '../knowledge-api.service.js';
import { SourceController } from './source.controller.js';
import { SourceService } from './source.service.js';
import { SOURCE_STORAGE, SOURCE_WEB_FETCH } from './source.tokens.js';

@Module({
  controllers: [
    IngestJobController,
    KnowledgeFactController,
    KnowledgeSourceController,
    SourceController,
  ],
  exports: [KnowledgeApiService, SourceService, SOURCE_STORAGE, SOURCE_WEB_FETCH],
  imports: [AuthModule, IdempotencyModule, OutboxModule, RbacModule],
  providers: [
    {
      provide: SOURCE_STORAGE,
      useFactory: () => createStorageAdapter(readStorageConfiguration()),
    },
    {
      provide: SOURCE_WEB_FETCH,
      useFactory: () => new SafeWebFetchAdapter(readWebFetchConfiguration()),
    },
    SourceService,
    KnowledgeApiService,
  ],
})
export class SourceModule {}
