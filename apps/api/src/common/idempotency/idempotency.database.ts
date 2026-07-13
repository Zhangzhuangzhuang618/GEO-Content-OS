import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

import {
  createDatabaseConnection,
  type DatabaseClient,
  type DatabaseConnection,
} from '../../database/index.js';
import { getApiLogger } from '../telemetry/api-logger.js';

@Injectable()
export class IdempotencyDatabase implements OnApplicationShutdown {
  private connection: DatabaseConnection | undefined;

  public get client(): DatabaseClient {
    this.connection ??= createDatabaseConnection(undefined, { telemetryLogger: getApiLogger() });
    return this.connection.client;
  }

  public async onApplicationShutdown(): Promise<void> {
    if (!this.connection) return;
    await this.connection.client.end({ timeout: 5 });
    this.connection = undefined;
  }
}
