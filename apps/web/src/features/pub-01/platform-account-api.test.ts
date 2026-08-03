import { afterEach, describe, expect, it, vi } from 'vitest';

import { startBaijiahaoBrowserLogin } from './platform-account-api';
import type { PlatformAccountRequestError } from './platform-account-api';
import type { PlatformAccount } from './platform-account.schema';

const ACCOUNT = {
  id: '00000000-0000-4000-8000-000000000145',
  version: 4,
} as PlatformAccount;

describe('Baijiahao browser login API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retains the public error code and safe gateway reason for the UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'STATE_TRANSITION_INVALID',
                details: { reason: 'PAGE_SIGNATURE_CHANGED', upstream_status: 423 },
                message: '状态转换不允许',
                request_id: '00000000-0000-4000-8000-000000000146',
              },
            }),
            { status: 409 },
          ),
      ),
    );

    await expect(startBaijiahaoBrowserLogin(ACCOUNT, 'csrf-token')).rejects.toEqual(
      expect.objectContaining<Partial<PlatformAccountRequestError>>({
        code: 'STATE_TRANSITION_INVALID',
        details: { reason: 'PAGE_SIGNATURE_CHANGED', upstream_status: 423 },
        status: 409,
      }),
    );
  });
});
