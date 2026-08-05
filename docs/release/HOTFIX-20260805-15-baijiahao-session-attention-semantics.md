# HOTFIX-20260805-15 百家号浏览器安全暂停语义修复

## 问题

百家号发布遇到页面结构变化、验证码等浏览器操作异常后，会话会进入 `attention_required`。后续发布请求把所有非 `authenticated` 状态统一返回为 `AUTH_REQUIRED`，导致用户误以为登录已过期；“实时核验登录态”也不会重新核验该状态。

## 修复

- 发布前遇到 `attention_required` 返回 `423 SESSION_ATTENTION_REQUIRED`，与真实的登录失效分开。
- 保留异常后暂停自动发布的安全策略，不自动重试未知页面操作。
- 用户主动点击“实时核验登录态”时，允许使用已加密保存的会话重新核验；核验通过后恢复为 `authenticated`。
- 页面明确显示“浏览器操作安全暂停，未判定登录过期”，并提供“检查并恢复”入口。

## 验收

- `attention_required` 不再返回 `AUTH_REQUIRED`。
- 真实未登录或登录失效仍返回 `AUTH_REQUIRED`，并进入 `reauth`。
- 人工实时核验通过后解除安全暂停。
- 百家号浏览器 Worker 单元测试和发布管理页面测试通过。
