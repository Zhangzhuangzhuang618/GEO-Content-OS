import { describe, expect, it } from 'vitest';

import { baijiahaoLoginErrorMessage } from './baijiahao-login-error';
import { PlatformAccountRequestError } from './platform-account-api';

describe('Baijiahao browser login errors', () => {
  it('explains a temporary browser gateway outage without presenting it as a state conflict', () => {
    expect(
      baijiahaoLoginErrorMessage(
        new PlatformAccountRequestError(503, 'BROWSER_GATEWAY_UNAVAILABLE', {
          reason: 'BROWSER_GATEWAY_UNAVAILABLE',
        }),
      ),
    ).toBe('托管浏览器暂时不可用。请稍后再次扫码；若持续出现，请检查百家号浏览器 Worker。');
  });

  it('uses the same actionable message when an upstream proxy only returns HTTP 500', () => {
    expect(baijiahaoLoginErrorMessage(new PlatformAccountRequestError(500))).toContain(
      '托管浏览器暂时不可用',
    );
  });
});
