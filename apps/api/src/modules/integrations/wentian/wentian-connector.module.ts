import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../../common/idempotency/idempotency.module.js';
import { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import { AuthModule } from '../../identity/auth/auth.module.js';
import { RbacModule } from '../../identity/rbac/rbac.module.js';
import {
  readWentianConnectorConfiguration,
  WENTIAN_CONNECTOR_CONFIGURATION,
  type WentianConnectorConfiguration,
} from './wentian-connector.config.js';
import { WentianConnectorController } from './wentian-connector.controller.js';
import { WentianConnectorService } from './wentian-connector.service.js';
import { WentianSignedClient } from './wentian-signed-client.js';

@Module({
  controllers: [WentianConnectorController],
  imports: [AuthModule, IdempotencyModule, RbacModule],
  providers: [
    {
      provide: WENTIAN_CONNECTOR_CONFIGURATION,
      useFactory: () => readWentianConnectorConfiguration(),
    },
    {
      provide: WentianSignedClient,
      inject: [WENTIAN_CONNECTOR_CONFIGURATION],
      useFactory: (configuration: WentianConnectorConfiguration) =>
        new WentianSignedClient(configuration),
    },
    {
      provide: WentianConnectorService,
      inject: [IdentityAuthDatabase, WENTIAN_CONNECTOR_CONFIGURATION, WentianSignedClient],
      useFactory: (
        database: IdentityAuthDatabase,
        configuration: WentianConnectorConfiguration,
        client: WentianSignedClient,
      ) => new WentianConnectorService(database, configuration, client),
    },
  ],
})
export class WentianConnectorModule {}
