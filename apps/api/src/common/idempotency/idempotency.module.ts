import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

import { createDatabaseConnection, type DatabaseClient } from '../../database/index.js';
import { IdempotencyService } from './idempotency.service.js';
import { IDEMPOTENCY_DATABASE_CLIENT } from './idempotency.tokens.js';

@Injectable()
class IdempotencyDatabaseLifecycle implements OnApplicationShutdown {
  public constructor(
    @Inject(IDEMPOTENCY_DATABASE_CLIENT) private readonly client: DatabaseClient,
  ) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}

@Module({
  providers: [
    {
      provide: IDEMPOTENCY_DATABASE_CLIENT,
      useFactory: (): DatabaseClient => createDatabaseConnection().client,
    },
    IdempotencyDatabaseLifecycle,
    IdempotencyService,
  ],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
