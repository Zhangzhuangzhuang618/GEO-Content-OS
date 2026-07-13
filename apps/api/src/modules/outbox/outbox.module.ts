import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

import { getApiLogger } from '../../common/telemetry/api-logger.js';
import { createDatabaseConnection, type DatabaseClient } from '../../database/index.js';
import { OUTBOX_DATABASE_CLIENT } from './outbox.tokens.js';
import { OutboxWriter } from './outbox.writer.js';

@Injectable()
class OutboxDatabaseLifecycle implements OnApplicationShutdown {
  public constructor(@Inject(OUTBOX_DATABASE_CLIENT) private readonly client: DatabaseClient) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}

@Module({
  providers: [
    {
      provide: OUTBOX_DATABASE_CLIENT,
      useFactory: (): DatabaseClient =>
        createDatabaseConnection(undefined, { telemetryLogger: getApiLogger() }).client,
    },
    OutboxDatabaseLifecycle,
    OutboxWriter,
  ],
  exports: [OutboxWriter],
})
export class OutboxModule {}
