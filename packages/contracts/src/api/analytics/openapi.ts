import { z } from 'zod';

import type { AnalyticsApiContract } from './index.js';

export function buildAnalyticsOpenApiDocument(contracts: readonly AnalyticsApiContract[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const contract of contracts) {
    const parameters: Record<string, unknown>[] = [];
    for (const match of contract.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)) {
      parameters.push({
        in: 'path',
        name: match[1],
        required: true,
        schema: { format: 'uuid', type: 'string' },
      });
    }
    if (contract.querySchema) {
      const query = z.toJSONSchema(contract.querySchema) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const [name, schema] of Object.entries(query.properties ?? {})) {
        parameters.push({
          in: 'query',
          name,
          required: query.required?.includes(name) ?? false,
          schema,
        });
      }
    }
    if (contract.idempotency !== '-') {
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
              content: {
                [contract.requestContentType]: { schema: z.toJSONSchema(contract.bodySchema) },
              },
              required: true,
            },
          }
        : contract.requestContentType === 'multipart/form-data'
          ? {
              requestBody: {
                content: {
                  'multipart/form-data': {
                    schema: {
                      additionalProperties: false,
                      properties: {
                        file: { format: 'binary', type: 'string' },
                        workspace_id: { format: 'uuid', type: 'string' },
                      },
                      required: ['file', 'workspace_id'],
                      type: 'object',
                    },
                  },
                },
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
      tags: ['Analytics'],
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
    info: { title: 'GEO Content OS Analytics API', version: '2.1.0' },
    openapi: '3.1.0' as const,
    paths: Object.freeze(paths),
  });
}
