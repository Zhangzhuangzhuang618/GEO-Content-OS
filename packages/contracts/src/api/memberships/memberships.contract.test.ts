import { describe, expect, it } from 'vitest';

import {
  CreateInvitationRequestSchema,
  MEMBERSHIP_API_CONTRACTS,
  MEMBERSHIP_OPENAPI_DOCUMENT,
  UpdateMembershipRequestSchema,
} from './index.js';

describe('membership API contract', () => {
  it('freezes member administration and invitation listing endpoints', () => {
    expect(MEMBERSHIP_API_CONTRACTS.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /memberships',
      'PATCH /memberships/{id}',
      'POST /memberships/{id}/disable',
      'POST /memberships/{id}/restore',
      'GET /invitations',
      'POST /invitations',
    ]);
    expect(MEMBERSHIP_OPENAPI_DOCUMENT.openapi).toBe('3.1.0');
    expect(
      Object.values(MEMBERSHIP_OPENAPI_DOCUMENT.paths).flatMap((path) => Object.values(path)),
    ).toHaveLength(6);
    expect(MEMBERSHIP_OPENAPI_DOCUMENT.paths['/memberships/{id}']?.['patch']).toMatchObject({
      'x-idempotency': 'key+version',
      'x-permission': 'tenant.members.manage',
      'x-policy': 'tenant_admin_or_owner',
    });
  });

  it('requires unique workspace scope and a membership change', () => {
    const first = '10000000-0000-4000-8000-000000000098';
    const second = '20000000-0000-4000-8000-000000000098';
    expect(
      CreateInvitationRequestSchema.safeParse({
        email: 'user@example.com',
        role_code: 'viewer',
        workspace_scope: { workspace_ids: [second, first, second] },
      }).success,
    ).toBe(false);
    expect(
      CreateInvitationRequestSchema.safeParse({
        email: 'user@example.com',
        role_code: 'viewer',
        workspace_scope: { workspace_ids: [second, first] },
      }).success,
    ).toBe(true);
    expect(UpdateMembershipRequestSchema.safeParse({}).success).toBe(false);
  });
});
