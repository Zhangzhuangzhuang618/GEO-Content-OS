import { z } from 'zod';

import type { PublishingApiContract } from './index.js';

export function buildPublishingOpenApiDocument(contracts: readonly PublishingApiContract[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const contract of contracts) {
    const parameters = pathParameters(contract.path);
    if (contract.querySchema) parameters.push(...queryParameters(contract.querySchema));
    if (contract.idempotency.includes('version')) parameters.push(versionParameter());
    if (contract.idempotency.startsWith('key+')) parameters.push(idempotencyParameter());
    const item = paths[contract.path] ?? {};
    item[contract.method.toLowerCase()] = {
      ...(contract.bodySchema
        ? {
            requestBody: {
              content: { 'application/json': { schema: z.toJSONSchema(contract.bodySchema) } },
              required: true,
            },
          }
        : {}),
      'x-idempotency': contract.idempotency,
      'x-permission': contract.permission,
      'x-policy': contract.policy,
      operationId: contract.key.replaceAll('.', '_'),
      parameters,
      responses: {
        [contract.successStatus]: {
          content: { 'application/json': { schema: z.toJSONSchema(contract.responseSchema) } },
          description: contract.responseName,
        },
      },
      security:
        contract.method === 'GET'
          ? [{ sessionCookie: [] }]
          : [{ csrfCookie: [], sessionCookie: [] }],
      tags: ['Publishing'],
    };
    paths[contract.path] = item;
  }
  return Object.freeze({
    components: {
      securitySchemes: {
        csrfCookie: { in: 'cookie', name: 'geo_csrf', type: 'apiKey' },
        sessionCookie: { in: 'cookie', name: 'geo_session', type: 'apiKey' },
      },
    },
    info: { title: 'GEO Content OS Publishing API', version: '2.1.0' },
    openapi: '3.1.0' as const,
    paths: Object.freeze(paths),
  });
}

function pathParameters(path: string): Record<string, unknown>[] {
  return [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)].map((match) => ({
    in: 'path',
    name: match[1],
    required: true,
    schema: { format: 'uuid', type: 'string' },
  }));
}

function queryParameters(schema: z.ZodType): Record<string, unknown>[] {
  const json = z.toJSONSchema(schema) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({
    in: 'query',
    name,
    required: required.has(name),
    schema: property,
  }));
}

function versionParameter() {
  return {
    in: 'header',
    name: 'If-Match',
    required: true,
    schema: { pattern: '^(?:"[1-9][0-9]*"|[1-9][0-9]*)$', type: 'string' },
  };
}

function idempotencyParameter() {
  return {
    in: 'header',
    name: 'Idempotency-Key',
    required: true,
    schema: { maxLength: 128, minLength: 8, type: 'string' },
  };
}
