import { Injectable, type OnModuleDestroy } from '@nestjs/common';

import {
  createDatabaseConnection,
  type DatabaseClient,
  type DatabaseConnection,
} from '../../../database/index.js';

@Injectable()
export class IdentityAuthDatabase implements OnModuleDestroy {
  private connection: DatabaseConnection | undefined;

  public get client(): DatabaseClient {
    this.connection ??= createDatabaseConnection();
    return this.connection.client;
  }

  public async onModuleDestroy(): Promise<void> {
    if (!this.connection) return;
    await this.connection.client.end();
    this.connection = undefined;
  }
}
