import { createStorageAdapter, readStorageConfiguration } from '@geo-content-os/adapter-storage';
import type { CredentialEnvelopeService } from '@geo-content-os/security/credentials';
import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../common/idempotency/idempotency.module.js';
import { IdentityAuthDatabase } from '../identity/auth/auth.database.js';
import { AuthModule } from '../identity/auth/auth.module.js';
import { RbacModule } from '../identity/rbac/rbac.module.js';
import { OutboxModule, OutboxWriter } from '../outbox/index.js';
import {
  PlatformAccountController,
  PublishJobController,
} from './api/publishing-api.controller.js';
import { PublishingApiService } from './api/publishing-api.service.js';
import {
  BaijiahaoAutomationPolicyService,
  BaijiahaoBrowserGatewayClient,
  OfficialSiteAutomationPolicyService,
  PlatformAccountService,
  SohuBrowserGatewayClient,
  SohuBrowserSessionService,
  type PlatformAccountConnector,
} from './accounts/index.js';
import { PlatformDeliveryAccountConnector } from './accounts/platform-account.connector.js';
import { PublishJobService } from './jobs/index.js';
import { createPublishingCredentialService } from './publishing.credentials.js';
import {
  PUBLISHING_ACCOUNT_CONNECTOR,
  PUBLISHING_CREDENTIALS,
  PUBLISHING_STORAGE,
} from './publishing.tokens.js';

@Module({
  controllers: [PlatformAccountController, PublishJobController],
  exports: [PublishingApiService],
  imports: [AuthModule, IdempotencyModule, OutboxModule, RbacModule],
  providers: [
    { provide: PUBLISHING_ACCOUNT_CONNECTOR, useClass: PlatformDeliveryAccountConnector },
    { provide: PUBLISHING_CREDENTIALS, useFactory: createPublishingCredentialService },
    {
      provide: PUBLISHING_STORAGE,
      useFactory: () => createStorageAdapter(readStorageConfiguration()),
    },
    {
      inject: [IdentityAuthDatabase, PUBLISHING_CREDENTIALS, PUBLISHING_ACCOUNT_CONNECTOR],
      provide: PlatformAccountService,
      useFactory: (
        database: IdentityAuthDatabase,
        credentials: CredentialEnvelopeService,
        connector: PlatformAccountConnector,
      ) => new PlatformAccountService(database, credentials, connector),
    },
    {
      inject: [IdentityAuthDatabase],
      provide: OfficialSiteAutomationPolicyService,
      useFactory: (database: IdentityAuthDatabase) =>
        new OfficialSiteAutomationPolicyService(database),
    },
    {
      provide: BaijiahaoBrowserGatewayClient,
      useFactory: () => new BaijiahaoBrowserGatewayClient(),
    },
    {
      provide: SohuBrowserGatewayClient,
      useFactory: () => new SohuBrowserGatewayClient(),
    },
    {
      inject: [IdentityAuthDatabase, SohuBrowserGatewayClient],
      provide: SohuBrowserSessionService,
      useFactory: (database: IdentityAuthDatabase, gateway: SohuBrowserGatewayClient) =>
        new SohuBrowserSessionService(database, gateway),
    },
    {
      inject: [IdentityAuthDatabase, BaijiahaoBrowserGatewayClient],
      provide: BaijiahaoAutomationPolicyService,
      useFactory: (database: IdentityAuthDatabase, gateway: BaijiahaoBrowserGatewayClient) =>
        new BaijiahaoAutomationPolicyService(database, gateway),
    },
    {
      inject: [IdentityAuthDatabase, OutboxWriter],
      provide: PublishJobService,
      useFactory: (database: IdentityAuthDatabase, outbox: OutboxWriter) =>
        new PublishJobService(database, outbox),
    },
    {
      inject: [IdentityAuthDatabase, PUBLISHING_STORAGE, OutboxWriter],
      provide: PublishingApiService,
      useFactory: (
        database: IdentityAuthDatabase,
        storage: ReturnType<typeof createStorageAdapter>,
        outbox: OutboxWriter,
      ) => new PublishingApiService(database, storage, outbox),
    },
  ],
})
export class PublishingModule {}
