import { describe, expect, it } from 'vitest';

import { deterministicUuid, SMOKE_FIXTURE } from './fixtures.js';

describe('shared smoke fixtures', () => {
  it('provides stable SaaS scope identifiers', () => {
    expect(SMOKE_FIXTURE).toEqual({
      tenantId: '00000000-0000-4000-8000-000000000001',
      userEmail: 'owner@example.test',
      userId: '00000000-0000-4000-8000-000000000002',
      workspaceId: '00000000-0000-4000-8000-000000000003',
    });
  });

  it('creates deterministic UUID-shaped values and rejects unsafe sequences', () => {
    expect(deterministicUuid(42)).toBe('00000000-0000-4000-8000-000000000042');
    expect(() => deterministicUuid(-1)).toThrow('Fixture sequence');
  });
});
