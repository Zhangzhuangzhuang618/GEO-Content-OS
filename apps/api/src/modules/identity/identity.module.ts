import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module.js';
import { InvitationModule } from './invitations/invitation.module.js';
import { PasswordModule } from './password/password.module.js';
import { TenantContextModule } from './tenant-context/tenant-context.module.js';

@Module({
  exports: [AuthModule, InvitationModule, PasswordModule, TenantContextModule],
  imports: [AuthModule, InvitationModule, PasswordModule, TenantContextModule],
})
export class IdentityModule {}
