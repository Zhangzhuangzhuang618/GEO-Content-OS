import 'reflect-metadata';

import {
  findContentApiContract,
  type ContentApiContractKey,
  type ContentApiMethod,
} from '@geo-content-os/contracts';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';

import { POLICY_REQUIREMENT_METADATA, type PolicyRequirement } from '../identity/rbac/index.js';
import {
  ContentPackageController,
  ContentVariantController,
  ContentVersionController,
  GenerationRunController,
} from './api/index.js';
import { BriefController } from './briefs/index.js';

interface Binding {
  readonly controller: object;
  readonly handler: object;
  readonly key: ContentApiContractKey;
}

const bindings: readonly Binding[] = [
  bind('brief.create', BriefController, BriefController.prototype.create),
  bind('brief.list', BriefController, BriefController.prototype.list),
  bind('brief.get', BriefController, BriefController.prototype.find),
  bind('brief.update', BriefController, BriefController.prototype.update),
  bind('package.create', ContentPackageController, ContentPackageController.prototype.create),
  bind('package.list', ContentPackageController, ContentPackageController.prototype.list),
  bind('package.get', ContentPackageController, ContentPackageController.prototype.find),
  bind('package.generate', ContentPackageController, ContentPackageController.prototype.generate),
  bind('package.abandon', ContentPackageController, ContentPackageController.prototype.abandon),
  bind('package.archive', ContentPackageController, ContentPackageController.prototype.archive),
  bind('package.reopen', ContentPackageController, ContentPackageController.prototype.reopen),
  bind('run.get', GenerationRunController, GenerationRunController.prototype.find),
  bind('run.cancel', GenerationRunController, GenerationRunController.prototype.cancel),
  bind('version.get', ContentVersionController, ContentVersionController.prototype.find),
  bind('version.diff', ContentVersionController, ContentVersionController.prototype.diff),
  bind('version.rollback', ContentVersionController, ContentVersionController.prototype.rollback),
  bind('variant.get', ContentVariantController, ContentVariantController.prototype.find),
  bind('variant.update', ContentVariantController, ContentVariantController.prototype.update),
  bind('block.lock', ContentVariantController, ContentVariantController.prototype.lock),
  bind('block.unlock', ContentVariantController, ContentVariantController.prototype.unlock),
  bind(
    'variant.quality-check',
    ContentVariantController,
    ContentVariantController.prototype.quality,
  ),
  bind(
    'variant.regenerate',
    ContentVariantController,
    ContentVariantController.prototype.regenerate,
  ),
  bind('variant.drop', ContentVariantController, ContentVariantController.prototype.drop),
];

describe('content controller contract bindings', () => {
  it('binds all 23 frozen content contracts exactly once', () => {
    expect(bindings).toHaveLength(23);
    expect(new Set(bindings.map((binding) => binding.key)).size).toBe(23);
  });

  it.each(bindings)('$key matches method, route, permission, and success status', (binding) => {
    const contract = findContentApiContract(binding.key);
    const methodCode = Reflect.getMetadata(METHOD_METADATA, binding.handler) as RequestMethod;
    const requirement = Reflect.getMetadata(
      POLICY_REQUIREMENT_METADATA,
      binding.handler,
    ) as PolicyRequirement;

    expect(RequestMethod[methodCode] as ContentApiMethod).toBe(contract.method);
    expect(readRoute(binding.controller, binding.handler)).toBe(contract.path);
    expect(requirement).toEqual({ mode: 'all', permissions: [contract.permission] });
  });
});

function bind(key: ContentApiContractKey, controller: object, handler: object): Binding {
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
