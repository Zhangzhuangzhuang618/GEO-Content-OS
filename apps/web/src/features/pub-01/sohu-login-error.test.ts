import { describe, expect, it } from 'vitest';

import { PlatformAccountRequestError } from './platform-account-api';
import { sohuLoginErrorMessage } from './sohu-login-error';

describe('Sohu browser login errors', () => {
  it('uses the safe upstream reason even when the API maps the worker response to HTTP 409', () => {
    expect(
      sohuLoginErrorMessage(
        new PlatformAccountRequestError(409, 'STATE_TRANSITION_INVALID', {
          reason: 'AUTH_REQUIRED',
          upstream_status: 423,
        }),
      ),
    ).toContain('搜狐未接受本次登录');
  });

  it('explains a temporary browser gateway outage', () => {
    expect(
      sohuLoginErrorMessage(
        new PlatformAccountRequestError(503, 'BROWSER_GATEWAY_UNAVAILABLE', {
          reason: 'BROWSER_GATEWAY_UNAVAILABLE',
        }),
      ),
    ).toBe('搜狐号托管浏览器暂时不可用，请稍后重试。');
  });
});
