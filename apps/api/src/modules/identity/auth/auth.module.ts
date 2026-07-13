import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller.js';
import { IdentityAuthDatabase } from './auth.database.js';
import { AuthService } from './auth.service.js';
import { PasswordHasher } from './password-hasher.js';

@Module({
  controllers: [AuthController],
  exports: [AuthService, IdentityAuthDatabase, PasswordHasher],
  providers: [AuthService, IdentityAuthDatabase, PasswordHasher],
})
export class AuthModule {}
