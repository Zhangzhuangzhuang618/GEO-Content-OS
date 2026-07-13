import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthModule } from '../auth/auth.module.js';
import { PolicyGuard } from './policy.guard.js';
import { RbacService } from './rbac.service.js';

@Module({
  exports: [PolicyGuard, RbacService],
  imports: [AuthModule],
  providers: [PolicyGuard, RbacService, Reflector],
})
export class RbacModule {}
