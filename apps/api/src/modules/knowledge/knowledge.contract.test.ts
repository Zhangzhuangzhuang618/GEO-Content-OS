import 'reflect-metadata';

import {
  findKnowledgeApiContract,
  type KnowledgeApiContractKey,
  type KnowledgeApiMethod,
} from '@geo-content-os/contracts';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';

import { POLICY_REQUIREMENT_METADATA, type PolicyRequirement } from '../identity/rbac/index.js';
import { FactAdjudicationController } from './facts/adjudication/fact-adjudication.controller.js';
import {
  IngestJobController,
  KnowledgeFactController,
  KnowledgeSourceController,
} from './knowledge-api.controller.js';
import { SourceController } from './sources/source.controller.js';

interface ControllerBinding {
  readonly controller: object;
  readonly handler: object;
  readonly key: KnowledgeApiContractKey;
}

const bindings: readonly ControllerBinding[] = [
  bind('source.create', SourceController, SourceController.prototype.upload),
  bind('source.list', KnowledgeSourceController, KnowledgeSourceController.prototype.list),
  bind('source.get', KnowledgeSourceController, KnowledgeSourceController.prototype.find),
  bind('source.reindex', KnowledgeSourceController, KnowledgeSourceController.prototype.reindex),
  bind('source.delete', KnowledgeSourceController, KnowledgeSourceController.prototype.remove),
  bind('ingest-job.get', IngestJobController, IngestJobController.prototype.find),
  bind('fact.list', KnowledgeFactController, KnowledgeFactController.prototype.list),
  bind('fact.verify', FactAdjudicationController, FactAdjudicationController.prototype.adjudicate),
];

describe('knowledge controller contract bindings', () => {
  it('binds every frozen knowledge contract exactly once', () => {
    expect(bindings.map((binding) => binding.key)).toHaveLength(8);
    expect(new Set(bindings.map((binding) => binding.key).values()).size).toBe(8);
  });

  it.each(bindings)('$key matches its method, route, and permissions', (binding) => {
    const contract = findKnowledgeApiContract(binding.key);
    const methodCode = Reflect.getMetadata(METHOD_METADATA, binding.handler) as RequestMethod;
    const requirement = Reflect.getMetadata(
      POLICY_REQUIREMENT_METADATA,
      binding.handler,
    ) as PolicyRequirement;

    expect(RequestMethod[methodCode] as KnowledgeApiMethod).toBe(contract.method);
    expect(readRoute(binding.controller, binding.handler)).toBe(contract.path);
    expect(requirement).toEqual({ mode: 'all', permissions: contract.permissions });
  });
});

function bind(
  key: KnowledgeApiContractKey,
  controller: object,
  handler: object,
): ControllerBinding {
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
