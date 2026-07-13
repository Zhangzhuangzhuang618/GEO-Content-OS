import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module.js';

@Module({
  exports: [AuthModule],
  imports: [AuthModule],
})
export class IdentityModule {}
