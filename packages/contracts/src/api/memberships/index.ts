import type { PermissionCode, PolicyCode } from '../../permissions/index.js';
import type { z } from 'zod';

import { ReasonRequestSchema } from '../common.js';
import { buildMembershipOpenApiDocument } from './openapi.js';
import {
  CreateInvitationRequestSchema,
  InvitationListQuerySchema,
  InvitationPageResponseSchema,
  InvitationResponseSchema,
  MembershipIdSchema,
  MembershipListQuerySchema,
  MembershipPageResponseSchema,
  MembershipResponseSchema,
  UpdateMembershipRequestSchema,
} from './schemas.js';

export * from './openapi.js';
export * from './schemas.js';

export interface MembershipApiContract {
  readonly bodySchema: z.ZodType | null;
  readonly idempotency: '-' | 'key+body_hash' | 'key+version' | 'resource+version';
  readonly key: string;
  readonly method: 'DELETE' | 'GET' | 'PATCH' | 'POST';
  readonly paramsSchema: z.ZodType | null;
  readonly path: string;
  readonly permission: Extract<PermissionCode, 'tenant.members.manage' | 'tenant.members.read'>;
  readonly policy: Extract<PolicyCode, 'tenant_admin_or_owner'>;
  readonly querySchema: z.ZodType | null;
  readonly responseName: string;
  readonly responseSchema: z.ZodType | null;
  readonly successStatus: 200 | 201 | 204;
}

const contracts = [
  contract(
    'memberships.list',
    'GET',
    '/memberships',
    'tenant.members.read',
    '-',
    null,
    MembershipListQuerySchema,
    MembershipPageResponseSchema,
    'MembershipPage',
  ),
  contract(
    'memberships.update',
    'PATCH',
    '/memberships/{id}',
    'tenant.members.manage',
    'key+version',
    UpdateMembershipRequestSchema,
    null,
    MembershipResponseSchema,
    'MembershipView',
    200,
    MembershipIdSchema,
  ),
  contract(
    'memberships.disable',
    'POST',
    '/memberships/{id}/disable',
    'tenant.members.manage',
    'resource+version',
    ReasonRequestSchema,
    null,
    MembershipResponseSchema,
    'MembershipView',
    200,
    MembershipIdSchema,
  ),
  contract(
    'memberships.restore',
    'POST',
    '/memberships/{id}/restore',
    'tenant.members.manage',
    'resource+version',
    null,
    null,
    MembershipResponseSchema,
    'MembershipView',
    200,
    MembershipIdSchema,
  ),
  contract(
    'invitations.list',
    'GET',
    '/invitations',
    'tenant.members.read',
    '-',
    null,
    InvitationListQuerySchema,
    InvitationPageResponseSchema,
    'InvitationPage',
  ),
  contract(
    'invitations.create',
    'POST',
    '/invitations',
    'tenant.members.manage',
    'key+body_hash',
    CreateInvitationRequestSchema,
    null,
    InvitationResponseSchema,
    'InvitationView',
    201,
  ),
] as const satisfies readonly MembershipApiContract[];

export const MEMBERSHIP_API_CONTRACTS: readonly MembershipApiContract[] = Object.freeze(contracts);
export const MEMBERSHIP_OPENAPI_DOCUMENT = buildMembershipOpenApiDocument(contracts);

function contract(
  key: string,
  method: MembershipApiContract['method'],
  path: string,
  permission: MembershipApiContract['permission'],
  idempotency: MembershipApiContract['idempotency'],
  bodySchema: z.ZodType | null,
  querySchema: z.ZodType | null,
  responseSchema: z.ZodType | null,
  responseName: string,
  successStatus: MembershipApiContract['successStatus'] = 200,
  paramsSchema: z.ZodType | null = null,
): MembershipApiContract {
  return {
    bodySchema,
    idempotency,
    key,
    method,
    paramsSchema,
    path,
    permission,
    policy: 'tenant_admin_or_owner',
    querySchema,
    responseName,
    responseSchema,
    successStatus,
  };
}
