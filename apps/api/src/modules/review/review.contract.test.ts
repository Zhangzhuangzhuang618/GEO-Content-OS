import 'reflect-metadata';

import { findReviewApiContract, type ReviewApiContractKey } from '@geo-content-os/contracts';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';

import { POLICY_REQUIREMENT_METADATA, type PolicyRequirement } from '../identity/rbac/index.js';
import { ReviewSnapshotController, ReviewSubmissionController } from './api/index.js';

const bindings = [
  bind('review.submit', ReviewSubmissionController, ReviewSubmissionController.prototype.submit),
  bind('review.list', ReviewSnapshotController, ReviewSnapshotController.prototype.list),
  bind('review.get', ReviewSnapshotController, ReviewSnapshotController.prototype.detail),
  bind('review.approve', ReviewSnapshotController, ReviewSnapshotController.prototype.approve),
  bind('review.reject', ReviewSnapshotController, ReviewSnapshotController.prototype.reject),
  bind(
    'review.request-signoff',
    ReviewSnapshotController,
    ReviewSnapshotController.prototype.requestSignoff,
  ),
  bind('review.actions', ReviewSnapshotController, ReviewSnapshotController.prototype.actions),
] as const;

describe('review controller contract bindings', () => {
  it('binds all seven frozen review contracts exactly once', () => {
    expect(bindings).toHaveLength(7);
    expect(new Set(bindings.map((binding) => binding.key)).size).toBe(7);
  });

  it.each(bindings)('$key matches method, route, permission, and status', (binding) => {
    const contract = findReviewApiContract(binding.key);
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

function bind(key: ReviewApiContractKey, controller: object, handler: object) {
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
