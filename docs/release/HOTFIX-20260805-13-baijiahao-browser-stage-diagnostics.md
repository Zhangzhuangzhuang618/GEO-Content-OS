# HOTFIX-20260805-13 百家号浏览器发布阶段诊断

## 生产证据

- 百家号发布请求在提交前返回 `503 BROWSER_GATEWAY_UNAVAILABLE`。
- 本次没有 `pre_submit` 诊断制品，登录态、配图和对象存储均无异常。
- 网关此前只记录通用错误码和 HTTP 路径，底层 Playwright 异常及其发生阶段被丢弃，
  无法判断失败发生在编辑器加载、正文填写或图片上传。

## 修复

- 为百家号提交前浏览器操作增加稳定阶段标识，覆盖编辑器加载与核验、标题和正文填写、
  封面与正文图片上传、可选发布字段、提交前验证码核验以及截图保存。
- 未分类浏览器异常继续对调用方返回通用 `503 BROWSER_GATEWAY_UNAVAILABLE`，避免泄露内部信息。
- 网关服务端日志增加脱敏后的底层错误、阶段、错误码、方法和路径；Cookie、Token、密码、
  storage state 等敏感值继续被替换为 `[REDACTED]`。

## 边界与部署

- 不修改发布状态机、尝试上限、登录判断、质量门槛或浏览器选择器。
- 不自动判断远端是否已经发布，不绕过验证码或风控。
- 无公开 API 或数据库变更。
- 仅需重新构建并部署 Baijiahao Browser Worker。

## 部署后取证

重新执行一个新的受控百家号发布任务，然后检索：

```text
Baijiahao browser gateway request failed
PageDriverOperationError
browser_stage
```

日志中的 `stage` 用于确定下一次根因修复范围；公开 HTTP 响应仍保持通用错误信息。
