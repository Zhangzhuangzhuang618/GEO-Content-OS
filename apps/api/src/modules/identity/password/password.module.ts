import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PasswordController } from './password.controller.js';
import { DeferredPasswordResetDelivery, PasswordResetDelivery } from './password-reset.delivery.js';
import { PasswordService } from './password.service.js';

@Module({
  controllers: [PasswordController],
  exports: [PasswordService, PasswordResetDelivery],
  imports: [AuthModule],
  providers: [
    PasswordService,
    { provide: PasswordResetDelivery, useClass: DeferredPasswordResetDelivery },
  ],
})
export class PasswordModule {}
