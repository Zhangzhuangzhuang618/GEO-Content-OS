import { PlatformAccountRequestError } from './platform-account-api';
import type { DouyinBrowserSession } from './platform-account.schema';

export function douyinQrExpiryMessage(
  waitingForPrimaryQr: boolean,
  nextStatus: DouyinBrowserSession['status'],
): string | null {
  return waitingForPrimaryQr && nextStatus === 'login_required'
    ? '抖音登录二维码已过期，请重新生成后扫码。'
    : null;
}

export function isDouyinVerificationBlocked(error: unknown): boolean {
  return (
    error instanceof PlatformAccountRequestError &&
    (error.status === 423 ||
      error.details?.['reason'] === 'CAPTCHA_REQUIRED' ||
      error.details?.['upstream_status'] === 423)
  );
}
