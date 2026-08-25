import { PlatformAccountRequestError } from './platform-account-api';

export function sohuLoginErrorMessage(error: unknown): string {
  if (!(error instanceof PlatformAccountRequestError)) {
    return '无法启动搜狐号登录。请检查托管浏览器服务。';
  }
  if (error.code === 'VERSION_CONFLICT') {
    return '账号信息已经变化，请关闭搜狐号登录面板并重新打开后再试。';
  }
  const reason = error.details?.['reason'];
  if (
    error.code === 'BROWSER_GATEWAY_UNAVAILABLE' ||
    reason === 'BROWSER_GATEWAY_UNAVAILABLE' ||
    error.status >= 500
  ) {
    return '搜狐号托管浏览器暂时不可用，请稍后重试。';
  }
  if (reason === 'AUTH_REQUIRED') {
    return '搜狐未接受本次登录。请重新获取图形验证码和短信验证码；若验证码正确仍失败，请检查搜狐是否要求账号绑定或安全验证。';
  }
  if (reason === 'CAPTCHA_REQUIRED') {
    return '搜狐要求额外人工安全验证，自动登录已停止。';
  }
  if (reason === 'ACCOUNT_PERMISSION_REQUIRED') {
    return '当前搜狐账号没有图文发布权限，请先完成实名认证或开通相应权限。';
  }
  if (reason === 'PAGE_SIGNATURE_CHANGED') {
    return '搜狐登录页面结构已经变化，当前自动登录已安全停止。';
  }
  if (reason === 'GATEWAY_AUTH_FAILED') {
    return 'API 与搜狐浏览器服务的内部令牌不一致，请检查部署配置。';
  }
  if (reason === 'CONFLICT') {
    return '搜狐登录会话正在执行其他操作，请等待当前操作完成后重试。';
  }
  return '搜狐号登录未完成，请检查托管浏览器日志中的安全错误码。';
}
