import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  API_CONTRACTS,
  ApiErrorResponseSchema,
  type ApiContractCatalogItem,
} from '@geo-content-os/contracts';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';

import { readControllerRoutes } from './controller-routes.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const openApiPath = path.join(repositoryRoot, 'apps/api/openapi/openapi.json');
const sdkOperationsPath = path.join(repositoryRoot, 'packages/sdk/src/generated/operations.ts');
const checkOnly = process.argv.includes('--check');
const prettierConfig =
  (await resolveConfig(path.join(repositoryRoot, 'packages/sdk/src/generated/operations.ts'))) ??
  {};

verifyCatalogAgainstControllers();
const openApi = await format(JSON.stringify(buildOpenApiDocument()), {
  ...prettierConfig,
  parser: 'json',
});
const sdkOperations = await format(buildSdkOperations(), {
  ...prettierConfig,
  parser: 'typescript',
});

if (checkOnly) {
  assertCurrent(openApiPath, openApi);
  assertCurrent(sdkOperationsPath, sdkOperations);
  process.stdout.write(
    `OpenAPI and SDK are current: ${API_CONTRACTS.length} business operations.\n`,
  );
} else {
  fs.mkdirSync(path.dirname(openApiPath), { recursive: true });
  fs.mkdirSync(path.dirname(sdkOperationsPath), { recursive: true });
  fs.writeFileSync(openApiPath, openApi);
  fs.writeFileSync(sdkOperationsPath, sdkOperations);
  process.stdout.write(
    `Generated OpenAPI and SDK metadata for ${API_CONTRACTS.length} business operations.\n`,
  );
}

function verifyCatalogAgainstControllers(): void {
  const catalogRoutes = API_CONTRACTS.map(
    (contract) => `${contract.method} ${contract.path}`,
  ).sort();
  const controllerRoutes = readControllerRoutes(path.join(repositoryRoot, 'apps/api/src')).filter(
    (route) => !route.includes(' /health/'),
  );
  const duplicateCatalogRoutes = duplicates(catalogRoutes);
  const duplicateControllerRoutes = duplicates(controllerRoutes);
  const duplicateKeys = duplicates(API_CONTRACTS.map((contract) => contract.key));
  if (duplicateCatalogRoutes.length || duplicateControllerRoutes.length || duplicateKeys.length) {
    throw new Error(
      `Duplicate API facts: catalog=${duplicateCatalogRoutes.join(',')}; controllers=${duplicateControllerRoutes.join(',')}; keys=${duplicateKeys.join(',')}`,
    );
  }
  const missingControllers = catalogRoutes.filter((route) => !controllerRoutes.includes(route));
  const missingContracts = controllerRoutes.filter((route) => !catalogRoutes.includes(route));
  if (missingControllers.length || missingContracts.length) {
    throw new Error(
      `Controller/contract drift. Missing controllers: ${missingControllers.join(', ') || '-'}; missing contracts: ${missingContracts.join(', ') || '-'}`,
    );
  }
  if (catalogRoutes.length !== 159) {
    throw new Error(
      `Expected the executable ADR baseline of 159 business endpoints, got ${catalogRoutes.length}`,
    );
  }
}

function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const contract of API_CONTRACTS) {
    const pathItem = paths[contract.path] ?? {};
    pathItem[contract.method.toLowerCase()] = buildOperation(contract);
    paths[contract.path] = pathItem;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'GEO Content OS API',
      version: '2.1.0',
      description:
        'Generated from executable Zod contracts and verified against NestJS controllers.',
    },
    servers: [{ url: '/api/v1' }],
    paths,
    components: {
      securitySchemes: {
        csrfCookie: { in: 'cookie', name: 'geo_csrf', type: 'apiKey' },
        sessionCookie: { in: 'cookie', name: 'geo_session', type: 'apiKey' },
      },
    },
  };
}

function buildOperation(contract: ApiContractCatalogItem): Record<string, unknown> {
  const parameters = [
    ...pathParameters(contract),
    ...queryParameters(contract),
    ...headerParameters(contract),
  ];
  const response = contract.responseSchema
    ? {
        content: { 'application/json': { schema: toJsonSchema(contract.responseSchema) } },
        description: contract.responseName,
      }
    : { description: contract.responseName };
  return {
    operationId: operationId(contract.key),
    tags: [tagFor(contract.path)],
    'x-contract-key': contract.key,
    'x-idempotency': contract.idempotency,
    'x-permission': contract.permission,
    'x-policy': contract.policy,
    ...(parameters.length ? { parameters } : {}),
    ...(contract.bodySchema
      ? {
          requestBody: {
            content: {
              [contract.requestContentType]: { schema: toJsonSchema(contract.bodySchema) },
            },
            required: true,
          },
        }
      : {}),
    responses: {
      [contract.successStatus]: response,
      default: {
        content: { 'application/json': { schema: toJsonSchema(ApiErrorResponseSchema) } },
        description: 'API error envelope',
      },
    },
    security:
      contract.security === 'public'
        ? []
        : contract.security === 'session'
          ? [{ sessionCookie: [] }]
          : [{ csrfCookie: [], sessionCookie: [] }],
  };
}

function pathParameters(contract: ApiContractCatalogItem): Record<string, unknown>[] {
  const schema = contract.paramsSchema ? toJsonSchema(contract.paramsSchema) : undefined;
  const properties = readProperties(schema);
  return [...contract.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)].map((match) => ({
    in: 'path',
    name: match[1],
    required: true,
    schema: properties[match[1] ?? ''] ?? { type: 'string' },
  }));
}

function queryParameters(contract: ApiContractCatalogItem): Record<string, unknown>[] {
  if (!contract.querySchema) return [];
  const schema = toJsonSchema(contract.querySchema);
  const properties = readProperties(schema);
  const required = new Set(Array.isArray(schema['required']) ? schema['required'] : []);
  return Object.entries(properties).map(([name, propertySchema]) => ({
    in: 'query',
    name,
    required: required.has(name),
    schema: propertySchema,
  }));
}

function headerParameters(contract: ApiContractCatalogItem): Record<string, unknown>[] {
  const parameters: Record<string, unknown>[] = [];
  if (contract.idempotency.startsWith('key+')) {
    parameters.push({
      in: 'header',
      name: 'Idempotency-Key',
      required: true,
      schema: { maxLength: 128, minLength: 8, type: 'string' },
    });
  }
  if (contract.idempotency.includes('version')) {
    parameters.push({
      in: 'header',
      name: 'If-Match',
      required: true,
      schema: { pattern: '^(?:"[1-9][0-9]*"|[1-9][0-9]*)$', type: 'string' },
    });
  }
  return parameters;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const document = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete document['$schema'];
  return document;
}

function readProperties(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const properties = schema?.['properties'];
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : {};
}

function tagFor(routePath: string): string {
  const segment = routePath.split('/').filter(Boolean)[0] ?? 'system';
  return segment
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function operationId(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/gu, '_');
}

function buildSdkOperations(): string {
  const operations = Object.fromEntries(
    API_CONTRACTS.map((contract) => [
      operationId(contract.key),
      {
        idempotency: contract.idempotency,
        method: contract.method,
        path: contract.path,
        permission: contract.permission,
        security: contract.security,
      },
    ]),
  );
  return `// Generated by apps/api/openapi/generate.ts. Do not edit.\nexport const operations = ${JSON.stringify(operations, null, 2)} as const;\n\nexport type OperationId = keyof typeof operations;\n`;
}

function assertCurrent(file: string, expected: string): void {
  const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (actual !== expected) {
    throw new Error(`${path.relative(repositoryRoot, file)} is stale. Run pnpm generate:openapi.`);
  }
}

function duplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}
