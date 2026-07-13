import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module.js';
import { InvitationModule } from './invitations/invitation.module.js';
import { PasswordModule } from './password/password.module.js';

@Module({
  exports: [AuthModule, InvitationModule, PasswordModule],
  imports: [AuthModule, InvitationModule, PasswordModule],
})
export class IdentityModule {}
