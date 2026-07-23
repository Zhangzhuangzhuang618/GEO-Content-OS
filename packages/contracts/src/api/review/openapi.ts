import { z } from 'zod';

export interface ReviewOpenApiContract {
  readonly bodySchema: z.ZodType | null;
  readonly idempotency: string;
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly permission: string;
  readonly policy: string;
  readonly querySchema: z.ZodType | null;
  readonly responseName: string;
  readonly responseSchema: z.ZodType;
  readonly successStatus: number;
}

export function buildReviewOpenApiDocument(contracts: readonly ReviewOpenApiContract[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const contract of contracts) {
    const parameters = pathParameters(contract.path);
    if (contract.querySchema) parameters.push(...queryParameters(contract.querySchema));
    if (contract.idempotency === 'key+version') parameters.push(versionParameter());
    if (contract.idempotency.startsWith('key+')) parameters.push(idempotencyParameter());
    const path = paths[contract.path] ?? {};
    path[contract.method.toLowerCase()] = {
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
      operationId: contract.key.replaceAll('.', '_').replaceAll('-', '_'),
      parameters,
      responses: {
        [contract.successStatus]: {
          content: { 'application/json': { schema: z.toJSONSchema(contract.responseSchema) } },
          description: contract.responseName,
        },
        default: {
          content: {
            'application/json': {
              schema: {
                properties: {
                  error: {
                    properties: {
                      code: { type: 'string' },
                      message: { type: 'string' },
                      request_id: { type: 'string' },
                    },
                    required: ['code', 'message', 'request_id'],
                    type: 'object',
                  },
                },
                required: ['error'],
                type: 'object',
              },
            },
          },
          description: 'API error envelope',
        },
      },
      security:
        contract.method === 'GET'
          ? [{ sessionCookie: [] }]
          : [{ csrfCookie: [], sessionCookie: [] }],
      tags: ['Review'],
    };
    paths[contract.path] = path;
  }
  return Object.freeze({
    components: Object.freeze({
      securitySchemes: {
        csrfCookie: { in: 'cookie', name: 'geo_csrf', type: 'apiKey' },
        sessionCookie: { in: 'cookie', name: 'geo_session', type: 'apiKey' },
      },
    }),
    info: Object.freeze({ title: 'GEO Content OS Review API', version: '1.0.0' }),
    openapi: '3.1.0' as const,
    paths: Object.freeze(paths),
    tags: Object.freeze([{ description: 'Frozen content review workflow', name: 'Review' }]),
  });
}

function queryParameters(schema: z.ZodType): Record<string, unknown>[] {
  const document = z.toJSONSchema(schema) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
  const required = new Set(document.required ?? []);
  return Object.entries(document.properties ?? {}).map(([name, propertySchema]) => ({
    in: 'query',
    name,
    required: required.has(name),
    schema: propertySchema,
  }));
}

function pathParameters(path: string): Record<string, unknown>[] {
  return [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)].map((match) => ({
    in: 'path',
    name: match[1],
    required: true,
    schema: { format: 'uuid', type: 'string' },
  }));
}

function versionParameter() {
  return {
    description: 'Strong ETag integer version of the review snapshot',
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
