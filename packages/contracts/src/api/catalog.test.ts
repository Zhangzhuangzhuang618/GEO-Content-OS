import { describe, expect, it } from 'vitest';

import { API_CONTRACTS } from './catalog.js';

describe('API contract catalog', () => {
  it('contains the 157-operation executable ADR baseline without duplicates', () => {
    const routes = API_CONTRACTS.map((contract) => `${contract.method} ${contract.path}`);
    expect(routes).toHaveLength(157);
    expect(new Set(routes).size).toBe(157);
    expect(new Set(API_CONTRACTS.map((contract) => contract.key)).size).toBe(157);
  });

  it('contains the tenant profile endpoints missing from the original task graph', () => {
    expect(
      API_CONTRACTS.filter((contract) => contract.path === '/tenant').map((contract) => ({
        idempotency: contract.idempotency,
        method: contract.method,
        policy: contract.policy,
      })),
    ).toEqual([
      { idempotency: '-', method: 'GET', policy: 'tenant_member' },
      { idempotency: 'key+version', method: 'PATCH', policy: 'tenant_owner' },
    ]);
  });

  it('requires runtime schemas for every request and successful JSON response', () => {
    for (const contract of API_CONTRACTS) {
      if (contract.successStatus !== 202 && contract.successStatus !== 204) {
        expect(contract.responseSchema, contract.key).not.toBeNull();
      }
      if (['PATCH', 'POST'].includes(contract.method) && !allowsEmptyBody(contract.key)) {
        expect(contract.bodySchema, contract.key).not.toBeNull();
      }
    }
  });
});

function allowsEmptyBody(key: string): boolean {
  return [
    'auth.logout',
    'account.restore',
    'account.test',
    'account.baijiahao_browser_session.login',
    'account.baijiahao_browser_session.reauth',
    'account.sohu_browser_session.login',
    'account.sohu_browser_session.reauth',
    'account.lieju_browser_session.login',
    'account.lieju_browser_session.reauth',
    'memberships.restore',
    'platform.tenants.restore',
    'platform.tenants.owner_invitation.resend',
  ].includes(key);
}
