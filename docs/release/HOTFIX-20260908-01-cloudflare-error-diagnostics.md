# HOTFIX-20260908-01 Cloudflare 失败响应诊断日志

用户授权：补充生产图片供应商失败日志，属于 T148 / ADR-0030 的可观测性补丁。

## 证据与范围

- 生产保留的 AI Worker 日志没有供应商原始错误；实际容器代码遇到非 2xx 直接抛出 HTTP 状态摘要，未读取响应正文。
- 仅凭 HTTP 429 不能区分额度、限流和服务容量。本补丁不判定历史根因、不修复供应商故障。
- Cloudflare 生成和视觉质检的非 2xx、失败响应 envelope 输出单行 JSON，事件名为
  `cloudflare_image_provider_failure`。
- 记录 operation、model_id、request_id、http_status、cf_ray、provider_request_id、retry_after、
  error_body_available 和 errors 中的原始 code / 脱敏 message。
- 不输出请求正文、图片、完整响应、账户 ID 或 API Token；已知回显输入、凭证、URL、邮箱和手机号码脱敏。
- 错误正文读取最多 16 KiB / 1 秒；最多 5 条错误，每条消息最多 512 字符。
  非 JSON、超限或不可读时保留 HTTP 状态与追踪头，error_body_available=false。
- 日志失败不替代原异常。公开错误、数据库诊断摘要、重试次数、模板降级、质量门禁、计费及排期不变。
- 无迁移、配置、API 或 Web 改动；不触发额外模型请求，不重跑历史任务。

## 验证

- Node 22 下图片 Adapter 37 项测试通过（新增 14 项诊断测试），图片类型检查通过。
- AI Worker 全部 299 项测试通过，覆盖配图与降级流程。
- 修改文件 ESLint、Prettier 和 git diff --check 通过。
- 错误码 3036 / 3040 / 5006、生成与质检区分、凭证与输入脱敏、成功请求不输出失败日志、
  非 JSON / 超限 / 流读取失败 / 诊断超时 / 日志抛错均使用模拟响应验证，没有调用外部模型。

## 部署与回滚

- 部署前核对生产 HEAD、容器、API readiness、相关日志及 AI 队列活动状态。
- 从提交的干净归档构建 AI Worker，不将用户未追踪文件或服务器本地环境改动混入镜像。
- 替换前保留旧 Worker 镜像回滚标签及原始日志；只更新 ai-worker（no-deps），不动其他服务和数据卷。
- 部署后核对运行镜像、容器健康、API readiness，并在容器中用模拟 fetch 验证诊断代码。
- 回滚只恢复旧 AI Worker 镜像，无数据库回退。
- 下一次自然任务发生供应商错误后，查询 `cloudflare_image_provider_failure` 并按 request_id 关联任务。
  历史未保存的错误正文无法补回。
