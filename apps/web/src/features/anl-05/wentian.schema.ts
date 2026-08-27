import { z } from 'zod';

export const WentianBindingStatusSchema = z.enum([
  'pending_wentian',
  'active',
  'suspended',
  'rejected',
  'disconnected',
]);

export const WentianBindingSchema = z
  .object({
    decision_reason: z.string().max(500).nullable(),
    geo_project_ref: z.string().min(1).max(160),
    id: z.string().uuid(),
    requested_at: z.iso.datetime(),
    status: WentianBindingStatusSchema,
    updated_at: z.iso.datetime(),
    version: z.number().int().positive(),
    wentian_binding_id: z.string().uuid(),
    wentian_scope_id: z.string().uuid().nullable(),
  })
  .strict();

export const WentianQuerySyncSchema = z
  .object({
    id: z.string().uuid(),
    query_count: z.number().int().min(1).max(100),
    query_set_id: z.string().uuid(),
    query_set_revision: z.number().int().positive(),
    snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    synced_at: z.iso.datetime(),
    wentian_snapshot_id: z.string().uuid(),
  })
  .strict();

export const WentianConnectorStatusSchema = z
  .object({
    binding: WentianBindingSchema.nullable(),
    configuration_status: z.enum(['configured', 'not_configured', 'invalid']),
    contract_version: z.literal('wentian-geo-connector@1'),
    latest_sync: WentianQuerySyncSchema.nullable(),
  })
  .strict();

export const WentianSsoTicketSchema = z
  .object({
    expires_at: z.iso.datetime(),
    launch_url: z.url(),
  })
  .strict();

const MetaSchema = z.object({ request_id: z.string().min(1) }).passthrough();

export const WentianConnectorStatusResponseSchema = z
  .object({ data: WentianConnectorStatusSchema, meta: MetaSchema })
  .strict();
export const WentianBindingResponseSchema = z
  .object({ data: WentianBindingSchema, meta: MetaSchema })
  .strict();
export const WentianQuerySyncResponseSchema = z
  .object({ data: WentianQuerySyncSchema, meta: MetaSchema })
  .strict();
export const WentianSsoTicketResponseSchema = z
  .object({ data: WentianSsoTicketSchema, meta: MetaSchema })
  .strict();

export type WentianBinding = z.infer<typeof WentianBindingSchema>;
export type WentianConnectorStatus = z.infer<typeof WentianConnectorStatusSchema>;
export type WentianQuerySync = z.infer<typeof WentianQuerySyncSchema>;
