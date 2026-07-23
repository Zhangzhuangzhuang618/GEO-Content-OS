import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IdentityEmailModule } from '../email/email.module.js';
import { EmailPasswordResetDelivery } from './email-password-reset.delivery.js';
import { PasswordController } from './password.controller.js';
import { PasswordResetDelivery } from './password-reset.delivery.js';
import { PasswordService } from './password.service.js';

@Module({
  controllers: [PasswordController],
  exports: [PasswordService, PasswordResetDelivery],
  imports: [AuthModule, IdentityEmailModule],
  providers: [
    PasswordService,
    { provide: PasswordResetDelivery, useClass: EmailPasswordResetDelivery },
  ],
})
export class PasswordModule {}
