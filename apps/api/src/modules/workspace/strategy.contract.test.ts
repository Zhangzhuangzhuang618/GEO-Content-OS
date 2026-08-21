import 'reflect-metadata';

import {
  findStrategyApiContract,
  type StrategyApiContractKey,
  type StrategyApiMethod,
} from '@geo-content-os/contracts';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { POLICY_REQUIREMENT_METADATA, type PolicyRequirement } from '../identity/rbac/index.js';
import { BrandProfileController } from './brand-profiles/brand-profile.controller.js';
import { KeywordController } from './keywords/keyword.controller.js';
import { TopicCandidateController, TopicPlanController } from './topics/topic.controller.js';

interface ControllerBinding {
  readonly controller: object;
  readonly handler: object;
  readonly key: StrategyApiContractKey;
}

const bindings: readonly ControllerBinding[] = [
  bind('brand-profile.create', BrandProfileController, BrandProfileController.prototype.create),
  bind('brand-profile.list', BrandProfileController, BrandProfileController.prototype.list),
  bind('brand-profile.get', BrandProfileController, BrandProfileController.prototype.find),
  bind('brand-profile.publish', BrandProfileController, BrandProfileController.prototype.publish),
  bind('brand-profile.retire', BrandProfileController, BrandProfileController.prototype.retire),
  bind('keyword-set.create', KeywordController, KeywordController.prototype.createSet),
  bind('keyword-set.list', KeywordController, KeywordController.prototype.list),
  bind('keyword-set.get', KeywordController, KeywordController.prototype.find),
  bind('keyword-set.list-keywords', KeywordController, KeywordController.prototype.listKeywords),
  bind('keyword-set.upsert-keywords', KeywordController, KeywordController.prototype.upsert),
  bind('keyword-set.batch-keywords', KeywordController, KeywordController.prototype.batch),
  bind(
    'keyword-set.sync-project-platform-scope',
    KeywordController,
    KeywordController.prototype.syncProjectPlatformScope,
  ),
  bind(
    'keyword-set.import.preflight',
    KeywordController,
    KeywordController.prototype.preflightImport,
  ),
  bind('keyword-set.import.commit', KeywordController, KeywordController.prototype.commitImport),
  bind('keyword-set.import.get', KeywordController, KeywordController.prototype.getImport),
  bind('topic-plan.generate', TopicPlanController, TopicPlanController.prototype.generate),
  bind('topic-candidate.list', TopicCandidateController, TopicCandidateController.prototype.list),
  bind('topic-candidate.adopt', TopicCandidateController, TopicCandidateController.prototype.adopt),
];

describe('strategy controller contract bindings', () => {
  it('binds every frozen strategy contract exactly once', () => {
    expect(bindings.map((binding) => binding.key)).toHaveLength(18);
    expect(new Set(bindings.map((binding) => binding.key)).size).toBe(18);
  });

  it.each(bindings)('$key matches its method, route, and permission', (binding) => {
    const contract = findStrategyApiContract(binding.key);
    const methodCode = Reflect.getMetadata(METHOD_METADATA, binding.handler) as RequestMethod;
    const requirement = Reflect.getMetadata(
      POLICY_REQUIREMENT_METADATA,
      binding.handler,
    ) as PolicyRequirement;

    expect(RequestMethod[methodCode] as StrategyApiMethod).toBe(contract.method);
    expect(readRoute(binding.controller, binding.handler)).toBe(contract.path);
    expect(requirement).toEqual({ mode: 'all', permissions: [contract.permission] });
  });
});

function bind(key: StrategyApiContractKey, controller: object, handler: object): ControllerBinding {
  return { controller, handler, key };
}

function readRoute(controller: object, handler: object): string {
  const controllerPath = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  const methodPath = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
  const route = `/${[controllerPath, methodPath]
    .map((part) => part.replace(/^\/+|\/+$/gu, ''))
    .filter(Boolean)
    .join('/')}`;
  return route.replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, '{$1}');
}
