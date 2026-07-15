import { z } from 'zod';

export interface TenantLifecycleOpenApiContract {
  readonly bodySchema: z.ZodType | null;
  readonly idempotency: '-' | 'key+body_hash';
  readonly key: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly permission: string;
  readonly policy: string;
  readonly responseName: string;
  readonly responseSchema: z.ZodType;
  readonly successStatus: 200 | 201;
}

export function buildTenantLifecycleOpenApiDocument(
  contracts: readonly TenantLifecycleOpenApiContract[],
) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const contract of contracts) {
    const parameters: Record<string, unknown>[] = [
      ...contract.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu),
    ].map((match) => ({
      in: 'path',
      name: match[1],
      required: true,
      schema: { format: 'uuid', type: 'string' },
    }));
    if (contract.idempotency.startsWith('key+')) {
      parameters.push({
        in: 'header',
        name: 'Idempotency-Key',
        required: true,
        schema: { maxLength: 128, minLength: 8, type: 'string' },
      });
    }
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
      tags: ['Tenant lifecycle'],
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
    info: { title: 'GEO Content OS Tenant Lifecycle API', version: '1.0.0' },
    openapi: '3.1.0' as const,
    paths: Object.freeze(paths),
  });
}
