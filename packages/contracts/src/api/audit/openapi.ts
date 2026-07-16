import { z } from 'zod';

import { AuditEventPageResponseSchema, AuditQuerySchema } from './schemas.js';

export function buildAuditOpenApiDocument() {
  const query = z.toJSONSchema(AuditQuerySchema) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return Object.freeze({
    components: {
      securitySchemes: {
        sessionCookie: { in: 'cookie', name: 'geo_session', type: 'apiKey' },
      },
    },
    info: { title: 'GEO Content OS Audit API', version: '2.1.0' },
    openapi: '3.1.0' as const,
    paths: Object.freeze({
      '/audit-events': {
        get: {
          operationId: 'audit_events_list',
          parameters: Object.entries(query.properties ?? {}).map(([name, schema]) => ({
            in: 'query',
            name,
            required: query.required?.includes(name) ?? false,
            schema,
          })),
          responses: {
            200: {
              content: {
                'application/json': { schema: z.toJSONSchema(AuditEventPageResponseSchema) },
              },
              description: 'AuditEventPage',
            },
          },
          security: [{ sessionCookie: [] }],
          tags: ['Audit'],
          'x-idempotency': '-',
          'x-permission': 'audit.read',
          'x-policy': 'tenant_owner',
        },
      },
    }),
  });
}
