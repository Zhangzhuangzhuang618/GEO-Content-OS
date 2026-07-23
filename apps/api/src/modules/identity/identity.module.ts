import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module.js';
import { InvitationModule } from './invitations/invitation.module.js';
import { MembershipModule } from './memberships/membership.module.js';
import { PasswordModule } from './password/password.module.js';
import { RbacModule } from './rbac/rbac.module.js';
import { TenantModule } from './tenant/tenant.module.js';
import { TenantContextModule } from './tenant-context/tenant-context.module.js';

@Module({
  exports: [
    AuthModule,
    InvitationModule,
    MembershipModule,
    PasswordModule,
    RbacModule,
    TenantModule,
    TenantContextModule,
  ],
  imports: [
    AuthModule,
    InvitationModule,
    MembershipModule,
    PasswordModule,
    RbacModule,
    TenantModule,
    TenantContextModule,
  ],
})
export class IdentityModule {}
