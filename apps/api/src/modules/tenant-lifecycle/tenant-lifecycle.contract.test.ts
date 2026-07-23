import { TENANT_LIFECYCLE_API_CONTRACTS } from '@geo-content-os/contracts';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';

import { TenantLifecycleController } from './tenant-lifecycle.controller.js';

describe('tenant lifecycle controller contract', () => {
  it('registers only the two frozen tenant export routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TenantLifecycleController)).toBe('tenant-exports');
    expect(TENANT_LIFECYCLE_API_CONTRACTS.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /tenant-exports',
      'GET /tenant-exports/{id}',
    ]);
  });
});
