import { z } from 'zod';

import { IsoDateTimeSchema, UuidSchema, createDataResponseSchema } from '../common.js';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const TenantExportRequestSchema = z.object({}).strict();
export const TenantExportParamsSchema = z.object({ id: UuidSchema }).strict();
export const TenantExportJobViewSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    error_json: z.record(z.string(), z.unknown()).nullable(),
    expires_at: IsoDateTimeSchema.nullable(),
    id: UuidSchema,
    manifest_hash: HashSchema.nullable(),
    object_uri: z.string().min(1).nullable(),
    requested_by: UuidSchema,
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'expired']),
    tenant_id: UuidSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

export const TenantExportJobResponseSchema = createDataResponseSchema(TenantExportJobViewSchema);
export type TenantExportRequest = z.infer<typeof TenantExportRequestSchema>;
