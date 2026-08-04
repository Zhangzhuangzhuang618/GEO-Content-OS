# HOTFIX-20260805-05 百家号实时登录核验诊断与状态同步

## 生产结论

- 网关健康检查和能力接口正常，但实时会话核验返回 503。
- 数据库仍显示 `authenticated`，因此缓存状态不能代表实时浏览器核验成功。
- 加密状态存在、密钥版本和当前密钥均已核对，现有证据不支持密钥不一致结论。
- 浏览器 Worker 此前未分类记录解密、页面签名、验证码或浏览器运行错误，也未在异常时同步会话状态，API 只能得到通用 503。

## 修复

- 实时核验捕获并脱敏记录底层错误及稳定错误码，不记录 Cookie、Token、密码或解密后的浏览器状态。
- 凭据解密失败、登录失效或页面要求重新登录时，会话同步为 `reauth`。
- 验证码、页面签名变化及浏览器运行异常时，会话同步为 `attention_required`，并将错误码写入 `last_error_json`。
- 同一账号并发核验进入锁后重新读取状态；前一个请求已更新状态时，后续请求不再重复启动浏览器。

## 边界

- 不绕过百家号验证码、登录或风控机制。
- 不自动删除加密登录态，不记录任何可复用凭据。
- 不修改发布质量门槛和内容生成链路。

## 部署后核验

1. 重建并更新 Baijiahao Browser Worker。
2. 点击“实时核验登录态”；接口应返回可处理的 `authenticated`、`reauth` 或 `attention_required` 状态，而不是无原因的通用 503。
3. 若需要人工处理，查询会话的 `last_error_json`，并检索 `Baijiahao browser session verification failed` 获取脱敏根因。
4. `CREDENTIAL_DECRYPTION_FAILED` 或 `LOGIN_EXPIRED` 需要重新扫码；`CAPTCHA_REQUIRED`、`PAGE_SIGNATURE_CHANGED` 或 `BROWSER_RUNTIME_FAILED` 按错误码检查页面或浏览器运行环境。

## 验证

- Baijiahao Browser Worker：4 个测试文件、15 项测试全部通过，覆盖解密失败、验证码、运行异常、敏感信息脱敏和并发核验去重。
- 全仓 TypeScript 类型检查通过。
- 全仓 ESLint 检查通过（排除用户现有未跟踪文件 `build_keywords.mjs`）。
- 本 Hotfix 相关文件 Prettier 检查通过。
