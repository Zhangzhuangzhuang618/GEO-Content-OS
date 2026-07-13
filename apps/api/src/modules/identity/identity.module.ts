import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module.js';
import { InvitationModule } from './invitations/invitation.module.js';
import { PasswordModule } from './password/password.module.js';
import { RbacModule } from './rbac/rbac.module.js';
import { TenantContextModule } from './tenant-context/tenant-context.module.js';

@Module({
  exports: [AuthModule, InvitationModule, PasswordModule, RbacModule, TenantContextModule],
  imports: [AuthModule, InvitationModule, PasswordModule, RbacModule, TenantContextModule],
})
export class IdentityModule {}
