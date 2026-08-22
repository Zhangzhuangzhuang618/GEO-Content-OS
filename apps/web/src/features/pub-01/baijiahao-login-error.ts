import { PlatformAccountRequestError } from './platform-account-api';

export function baijiahaoLoginErrorMessage(error: unknown): string {
  if (!(error instanceof PlatformAccountRequestError)) {
    return '无法启动扫码登录。请检查浏览器 Worker 和内部网关配置。';
  }
  if (error.code === 'VERSION_CONFLICT') {
    return '账号信息已经变化，请关闭百家号自动化面板并重新打开后再试。';
  }
  const reason = error.details?.['reason'];
  if (
    error.code === 'BROWSER_GATEWAY_UNAVAILABLE' ||
    reason === 'BROWSER_GATEWAY_UNAVAILABLE' ||
    error.status >= 500
  ) {
    return '托管浏览器暂时不可用。请稍后再次扫码；若持续出现，请检查百家号浏览器 Worker。';
  }
  if (reason === 'CAPTCHA_REQUIRED') {
    return '百度要求额外人工验证，自动化已停止。请在受控浏览器中完成人工处理后重试。';
  }
  if (reason === 'PAGE_SIGNATURE_CHANGED') {
    return '百度登录页面结构已经变化，当前自动化已安全停止，需要更新页面适配。';
  }
  if (reason === 'GATEWAY_AUTH_FAILED') {
    return 'API 与浏览器 Worker 的内部令牌不一致，请检查部署环境配置。';
  }
  if (reason === 'CONFLICT') {
    return '浏览器登录会话发生并发变化，请等待当前操作结束后重试。';
  }
  return '托管浏览器无法完成登录启动，请检查浏览器 Worker 日志中的安全错误码。';
}
