import type { FastifyRequest } from 'fastify';

import type { PolicyContext } from './policy.types.js';

const policyContexts = new WeakMap<object, PolicyContext>();

export function setPolicyContext(request: FastifyRequest, context: PolicyContext): void {
  policyContexts.set(request, context);
}

export function getPolicyContext(request: FastifyRequest): PolicyContext | undefined {
  return policyContexts.get(request);
}
