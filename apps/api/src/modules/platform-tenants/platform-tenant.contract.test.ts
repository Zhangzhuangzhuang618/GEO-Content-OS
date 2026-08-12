import 'reflect-metadata';

import {
  findPlatformTenantApiContract,
  type PlatformTenantApiContractKey,
} from '@geo-content-os/contracts';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';

import { POLICY_REQUIREMENT_METADATA, type PolicyRequirement } from '../identity/rbac/index.js';
import { PlatformTenantController } from './platform-tenant.controller.js';

interface Binding {
  readonly handler: object;
  readonly key: PlatformTenantApiContractKey;
}

const bindings: readonly Binding[] = [
  bind('platform.tenants.create', PlatformTenantController.prototype.create),
  bind('platform.tenants.list', PlatformTenantController.prototype.list),
  bind('platform.tenants.suspend', PlatformTenantController.prototype.suspend),
  bind('platform.tenants.restore', PlatformTenantController.prototype.restore),
  bind(
    'platform.tenants.owner_invitation.resend',
    PlatformTenantController.prototype.resendOwnerInvitation,
  ),
];

describe('platform tenant controller contract bindings', () => {
  it.each(bindings)('$key matches method, route, and authorization', (binding) => {
    const contract = findPlatformTenantApiContract(binding.key);
    const methodCode = Reflect.getMetadata(METHOD_METADATA, binding.handler) as RequestMethod;
    const requirement = Reflect.getMetadata(
      POLICY_REQUIREMENT_METADATA,
      PlatformTenantController,
    ) as PolicyRequirement;
    expect(RequestMethod[methodCode]).toBe(contract.method);
    expect(readRoute(PlatformTenantController, binding.handler)).toBe(contract.path);
    expect(requirement).toEqual({ mode: 'all', permissions: [contract.permission] });
  });
});

function bind(key: PlatformTenantApiContractKey, handler: object): Binding {
  return { handler, key };
}

function readRoute(controller: object, handler: object): string {
  const controllerPath = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  const handlerPath = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
  return `/${[controllerPath, handlerPath]
    .map((part) => part.replace(/^\/+|\/+$/gu, ''))
    .filter(Boolean)
    .join('/')}`.replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, '{$1}');
}
