import {
  POLICY_PERMISSIONS,
  type PermissionCode,
  type PolicyCode,
} from '@geo-content-os/contracts';
import { SetMetadata } from '@nestjs/common';

import type { PolicyRequirement } from './policy.types.js';

export const POLICY_REQUIREMENT_METADATA = 'geo.policy.requirement';

export function RequirePermissions(
  ...permissions: readonly PermissionCode[]
): MethodDecorator & ClassDecorator {
  return setRequirement({ mode: 'all', permissions });
}

export function RequireAnyPermission(
  ...permissions: readonly PermissionCode[]
): MethodDecorator & ClassDecorator {
  return setRequirement({ mode: 'any', permissions });
}

export function RequirePolicy(policy: PolicyCode): MethodDecorator & ClassDecorator {
  return RequirePermissions(...POLICY_PERMISSIONS[policy]);
}

export function RequireAnyPolicy(
  ...policies: readonly PolicyCode[]
): MethodDecorator & ClassDecorator {
  return RequireAnyPermission(...policies.flatMap((policy) => POLICY_PERMISSIONS[policy]));
}

function setRequirement(requirement: PolicyRequirement): MethodDecorator & ClassDecorator {
  if (requirement.permissions.length === 0) {
    throw new Error('A policy requirement must contain at least one permission');
  }
  return SetMetadata(POLICY_REQUIREMENT_METADATA, Object.freeze(requirement));
}
