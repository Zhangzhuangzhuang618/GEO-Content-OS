import { Module } from '@nestjs/common';

import { IdempotencyDatabase } from './idempotency.database.js';
import { IdempotencyService } from './idempotency.service.js';

@Module({
  providers: [IdempotencyDatabase, IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
