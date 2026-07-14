import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

import { getApiLogger } from '../../common/telemetry/api-logger.js';
import { createDatabaseConnection, type DatabaseClient } from '../../database/index.js';
import { OUTBOX_DATABASE_CLIENT } from './outbox.tokens.js';
import { OutboxWriter } from './outbox.writer.js';

export interface OutboxDatabaseProvider {
  readonly client: DatabaseClient;
}

@Injectable()
class LazyOutboxDatabase implements OnApplicationShutdown, OutboxDatabaseProvider {
  private databaseClient: DatabaseClient | undefined;

  public get client(): DatabaseClient {
    this.databaseClient ??= createDatabaseConnection(undefined, {
      telemetryLogger: getApiLogger(),
    }).client;
    return this.databaseClient;
  }

  public async onApplicationShutdown(): Promise<void> {
    if (!this.databaseClient) return;
    await this.databaseClient.end({ timeout: 5 });
    this.databaseClient = undefined;
  }
}

@Module({
  providers: [
    {
      provide: OUTBOX_DATABASE_CLIENT,
      useClass: LazyOutboxDatabase,
    },
    OutboxWriter,
  ],
  exports: [OutboxWriter],
})
export class OutboxModule {}
