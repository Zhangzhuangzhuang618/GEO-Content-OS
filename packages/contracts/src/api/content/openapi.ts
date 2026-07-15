import { z } from 'zod';

const VERSION_GUARDED = new Set([
  'brief.update',
  'package.generate',
  'package.abandon',
  'package.archive',
  'package.reopen',
  'run.cancel',
  'version.rollback',
  'variant.update',
  'block.lock',
  'block.unlock',
  'variant.regenerate',
  'variant.drop',
]);

export interface ContentOpenApiDocument {
  readonly components: Readonly<Record<string, unknown>>;
  readonly info: Readonly<Record<string, string>>;
  readonly openapi: '3.1.0';
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly tags: readonly Readonly<Record<string, string>>[];
}

export interface OpenApiContentContract {
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

/** Executable OpenAPI 3.1 projection of the frozen Content API contract. */
export function buildContentOpenApiDocument(
  contracts: readonly OpenApiContentContract[],
): ContentOpenApiDocument {
  return Object.freeze({
    components: Object.freeze({
      securitySchemes: {
        csrfCookie: { in: 'cookie', name: 'geo_csrf', type: 'apiKey' },
        sessionCookie: { in: 'cookie', name: 'geo_session', type: 'apiKey' },
      },
    }),
    info: Object.freeze({ title: 'GEO Content OS Content API', version: '1.0.0' }),
    openapi: '3.1.0',
    paths: Object.freeze(buildPaths(contracts)),
    tags: Object.freeze([
      { description: 'Brief creation and editing', name: 'Briefs' },
      { description: 'Content package orchestration', name: 'Content Packages' },
      { description: 'Generation run lifecycle', name: 'Generation Runs' },
      { description: 'Immutable content history', name: 'Content Versions' },
      { description: 'Platform variant editing and quality', name: 'Content Variants' },
    ]),
  });
}

function buildPaths(
  contracts: readonly OpenApiContentContract[],
): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const contract of contracts) {
    const path = paths[contract.path] ?? {};
    path[contract.method.toLowerCase()] = operation(contract);
    paths[contract.path] = path;
  }
  return paths;
}

function operation(contract: OpenApiContentContract): Readonly<Record<string, unknown>> {
  const parameters: Record<string, unknown>[] = pathParameters(contract.path);
  if (contract.querySchema) parameters.push(...queryParameters(contract.querySchema));
  if (VERSION_GUARDED.has(contract.key)) {
    parameters.push({
      description: 'Strong ETag integer version of the current aggregate',
      in: 'header',
      name: 'If-Match',
      required: true,
      schema: { pattern: '^(?:"[1-9][0-9]*"|[1-9][0-9]*)$', type: 'string' },
    });
  }
  if (contract.idempotency.startsWith('key+')) {
    parameters.push({
      in: 'header',
      name: 'Idempotency-Key',
      required: true,
      schema: { maxLength: 128, minLength: 8, type: 'string' },
    });
  }

  return Object.freeze({
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
      [String(contract.successStatus)]:
        contract.successStatus === 204
          ? { description: 'No Content' }
          : {
              content: {
                'application/json': { schema: z.toJSONSchema(contract.responseSchema) },
              },
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
      contract.method === 'GET' ? [{ sessionCookie: [] }] : [{ csrfCookie: [], sessionCookie: [] }],
    tags: [tagFor(contract.path)],
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

function tagFor(path: string): string {
  if (path.startsWith('/briefs')) return 'Briefs';
  if (path.startsWith('/generation-runs')) return 'Generation Runs';
  if (path.startsWith('/content-versions')) return 'Content Versions';
  if (path.startsWith('/content-variants')) return 'Content Variants';
  return 'Content Packages';
}
