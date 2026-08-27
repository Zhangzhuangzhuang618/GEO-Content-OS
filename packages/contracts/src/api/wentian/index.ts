import { z } from 'zod';

import type { PermissionCode, PolicyCode } from '../../permissions/index.js';
import {
  IsoDateTimeSchema,
  UuidSchema,
  VersionSchema,
  createDataResponseSchema,
} from '../common.js';

export const WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION = 'wentian-geo-connector@1' as const;

export const WentianProjectScopeSchema = z
  .object({
    project_id: UuidSchema,
    workspace_id: UuidSchema,
  })
  .strict();

export const WentianStatusQuerySchema = WentianProjectScopeSchema;
export const WentianBindingRequestSchema = WentianProjectScopeSchema;
export const WentianBindingRefreshRequestSchema = WentianProjectScopeSchema;
export const WentianSsoTicketRequestSchema = WentianProjectScopeSchema;
export const WentianQuerySetSyncRequestSchema = WentianProjectScopeSchema.extend({
  query_set_id: UuidSchema,
}).strict();
export const WentianBindingParamsSchema = z.object({ id: UuidSchema }).strict();

export const WentianBindingStatusSchema = z.enum([
  'pending_wentian',
  'active',
  'suspended',
  'rejected',
  'disconnected',
]);

export const WentianBindingViewSchema = z
  .object({
    decision_reason: z.string().max(500).nullable(),
    geo_project_ref: z.string().min(1).max(160),
    id: UuidSchema,
    requested_at: IsoDateTimeSchema,
    status: WentianBindingStatusSchema,
    updated_at: IsoDateTimeSchema,
    version: VersionSchema,
    wentian_binding_id: UuidSchema,
    wentian_scope_id: UuidSchema.nullable(),
  })
  .strict();

export const WentianQuerySyncViewSchema = z
  .object({
    id: UuidSchema,
    query_count: z.number().int().min(1).max(100),
    query_set_id: UuidSchema,
    query_set_revision: VersionSchema,
    snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    synced_at: IsoDateTimeSchema,
    wentian_snapshot_id: UuidSchema,
  })
  .strict();

export const WentianConnectorStatusViewSchema = z
  .object({
    binding: WentianBindingViewSchema.nullable(),
    configuration_status: z.enum(['configured', 'not_configured', 'invalid']),
    contract_version: z.literal(WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION),
    latest_sync: WentianQuerySyncViewSchema.nullable(),
  })
  .strict();

export const WentianSsoTicketViewSchema = z
  .object({
    expires_at: IsoDateTimeSchema,
    launch_url: z.url(),
  })
  .strict();

export const WentianConnectorStatusResponseSchema = createDataResponseSchema(
  WentianConnectorStatusViewSchema,
);
export const WentianBindingResponseSchema = createDataResponseSchema(WentianBindingViewSchema);
export const WentianQuerySyncResponseSchema = createDataResponseSchema(WentianQuerySyncViewSchema);
export const WentianSsoTicketResponseSchema = createDataResponseSchema(WentianSsoTicketViewSchema);

export type WentianBindingView = z.infer<typeof WentianBindingViewSchema>;
export type WentianConnectorStatusView = z.infer<typeof WentianConnectorStatusViewSchema>;
export type WentianQuerySyncView = z.infer<typeof WentianQuerySyncViewSchema>;

interface WentianApiContract {
  readonly bodySchema: z.ZodType | null;
  readonly idempotency: '-' | 'key+body_hash';
  readonly key: string;
  readonly method: 'DELETE' | 'GET' | 'POST';
  readonly paramsSchema: z.ZodType | null;
  readonly path: string;
  readonly permission: Extract<PermissionCode, 'tenant.members.manage' | 'tenant.profile.read'>;
  readonly policy: Extract<PolicyCode, 'tenant_admin_or_owner' | 'tenant_member'>;
  readonly querySchema: z.ZodType | null;
  readonly responseName: string;
  readonly responseSchema: z.ZodType;
  readonly successStatus: 200 | 201;
}

export const WENTIAN_API_CONTRACTS: readonly WentianApiContract[] = Object.freeze([
  contract(
    'wentian.status',
    'GET',
    '/integrations/wentian/status',
    'tenant_member',
    'tenant.profile.read',
    '-',
    null,
    WentianStatusQuerySchema,
    WentianConnectorStatusResponseSchema,
    'WentianConnectorStatusView',
  ),
  contract(
    'wentian.binding.request',
    'POST',
    '/integrations/wentian/bindings',
    'tenant_admin_or_owner',
    'tenant.members.manage',
    'key+body_hash',
    WentianBindingRequestSchema,
    null,
    WentianBindingResponseSchema,
    'WentianBindingView',
    201,
  ),
  contract(
    'wentian.binding.refresh',
    'POST',
    '/integrations/wentian/bindings/{id}/refresh',
    'tenant_admin_or_owner',
    'tenant.members.manage',
    'key+body_hash',
    WentianBindingRefreshRequestSchema,
    null,
    WentianBindingResponseSchema,
    'WentianBindingView',
    200,
    WentianBindingParamsSchema,
  ),
  contract(
    'wentian.binding.disconnect',
    'DELETE',
    '/integrations/wentian/bindings/{id}',
    'tenant_admin_or_owner',
    'tenant.members.manage',
    'key+body_hash',
    null,
    null,
    WentianBindingResponseSchema,
    'WentianBindingView',
    200,
    WentianBindingParamsSchema,
  ),
  contract(
    'wentian.sso-ticket.create',
    'POST',
    '/integrations/wentian/sso-tickets',
    'tenant_member',
    'tenant.profile.read',
    'key+body_hash',
    WentianSsoTicketRequestSchema,
    null,
    WentianSsoTicketResponseSchema,
    'WentianSsoTicketView',
    201,
  ),
  contract(
    'wentian.query-set.sync',
    'POST',
    '/integrations/wentian/query-set-syncs',
    'tenant_admin_or_owner',
    'tenant.members.manage',
    'key+body_hash',
    WentianQuerySetSyncRequestSchema,
    null,
    WentianQuerySyncResponseSchema,
    'WentianQuerySyncView',
    201,
  ),
]);

function contract(
  key: string,
  method: WentianApiContract['method'],
  path: string,
  policy: WentianApiContract['policy'],
  permission: WentianApiContract['permission'],
  idempotency: WentianApiContract['idempotency'],
  bodySchema: z.ZodType | null,
  querySchema: z.ZodType | null,
  responseSchema: z.ZodType,
  responseName: string,
  successStatus: WentianApiContract['successStatus'] = 200,
  paramsSchema: z.ZodType | null = null,
): WentianApiContract {
  return Object.freeze({
    bodySchema,
    idempotency,
    key,
    method,
    paramsSchema,
    path,
    permission,
    policy,
    querySchema,
    responseName,
    responseSchema,
    successStatus,
  });
}
