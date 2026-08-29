import { describe, expect, it } from 'vitest';

import { PlatformAccountRequestError } from './platform-account-api';
import { douyinQrExpiryMessage, isDouyinVerificationBlocked } from './douyin-browser-feedback';

describe('Douyin browser feedback', () => {
  it('reports expiry when a pending QR session returns to login_required', () => {
    expect(douyinQrExpiryMessage(true, 'login_required')).toBe(
      '抖音登录二维码已过期，请重新生成后扫码。',
    );
  });

  it('does not treat unrelated session transitions as QR expiry', () => {
    expect(douyinQrExpiryMessage(false, 'login_required')).toBeNull();
    expect(douyinQrExpiryMessage(true, 'authenticated')).toBeNull();
    expect(douyinQrExpiryMessage(true, 'attention_required')).toBeNull();
  });

  it('recognizes a worker verification block mapped to API HTTP 409', () => {
    expect(
      isDouyinVerificationBlocked(
        new PlatformAccountRequestError(409, 'STATE_TRANSITION_INVALID', {
          reason: 'CAPTCHA_REQUIRED',
          upstream_status: 423,
        }),
      ),
    ).toBe(true);
  });

  it('does not classify a gateway outage as a verification block', () => {
    expect(
      isDouyinVerificationBlocked(
        new PlatformAccountRequestError(503, 'BROWSER_GATEWAY_UNAVAILABLE', {
          reason: 'BROWSER_GATEWAY_UNAVAILABLE',
        }),
      ),
    ).toBe(false);
  });
});
