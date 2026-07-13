import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module.js';
import { PasswordModule } from './password/password.module.js';

@Module({
  exports: [AuthModule, PasswordModule],
  imports: [AuthModule, PasswordModule],
})
export class IdentityModule {}
