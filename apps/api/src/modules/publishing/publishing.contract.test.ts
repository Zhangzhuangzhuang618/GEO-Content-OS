import 'reflect-metadata';

import {
  findPublishingApiContract,
  type PublishingApiContractKey,
} from '@geo-content-os/contracts';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';

import { POLICY_REQUIREMENT_METADATA, type PolicyRequirement } from '../identity/rbac/index.js';
import { PlatformAccountController, PublishJobController } from './api/index.js';

interface Binding {
  readonly controller: object;
  readonly handler: object;
  readonly key: PublishingApiContractKey;
}

const bindings: readonly Binding[] = [
  bind('account.create', PlatformAccountController, PlatformAccountController.prototype.create),
  bind('account.list', PlatformAccountController, PlatformAccountController.prototype.list),
  bind('account.refresh', PlatformAccountController, PlatformAccountController.prototype.refresh),
  bind('account.test', PlatformAccountController, PlatformAccountController.prototype.test),
  bind('account.disable', PlatformAccountController, PlatformAccountController.prototype.disable),
  bind('job.create', PublishJobController, PublishJobController.prototype.create),
  bind('job.list', PublishJobController, PublishJobController.prototype.list),
  bind('job.get', PublishJobController, PublishJobController.prototype.detail),
  bind('job.cancel', PublishJobController, PublishJobController.prototype.cancel),
  bind('job.retry', PublishJobController, PublishJobController.prototype.retry),
  bind('job.attempts', PublishJobController, PublishJobController.prototype.attempts),
  bind('job.export', PublishJobController, PublishJobController.prototype.export),
];

describe('publishing controller contract bindings', () => {
  it('binds all 12 frozen publishing contracts exactly once', () => {
    expect(bindings).toHaveLength(12);
    expect(new Set(bindings.map(({ key }) => key)).size).toBe(12);
  });

  it.each(bindings)('$key matches method, route, and permission', (binding) => {
    const contract = findPublishingApiContract(binding.key);
    const methodCode = Reflect.getMetadata(METHOD_METADATA, binding.handler) as RequestMethod;
    const requirement = Reflect.getMetadata(
      POLICY_REQUIREMENT_METADATA,
      binding.handler,
    ) as PolicyRequirement;

    expect(RequestMethod[methodCode]).toBe(contract.method);
    expect(readRoute(binding.controller, binding.handler)).toBe(contract.path);
    expect(requirement).toEqual({ mode: 'all', permissions: [contract.permission] });
  });
});

function bind(key: PublishingApiContractKey, controller: object, handler: object): Binding {
  return { controller, handler, key };
}

function readRoute(controller: object, handler: object): string {
  const controllerPath = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  const handlerPath = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
  const route = `/${[controllerPath, handlerPath]
    .map((part) => part.replace(/^\/+|\/+$/gu, ''))
    .filter(Boolean)
    .join('/')}`;
  return route.replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, '{$1}');
}
