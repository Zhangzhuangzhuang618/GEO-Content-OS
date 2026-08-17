# ADR-0046：列举网官方 API 脱敏响应诊断

- 状态：已批准实施
- 日期：2026-08-18
- 任务：HOTFIX-20260818-02
- 影响范围：列举网官方 API 适配器、Publisher 失败记录
- 前置决策：ADR-0038、ADR-0044、ADR-0045

## 背景

列举网官方 API 可能返回 HTTP 2xx 但不包含当前适配器可识别的成功或拒绝语义。系统会正确
进入 `PUBLISH_STATE_UNKNOWN`，但之前只保留通用错误，无法区分空响应、HTML 页面、JSON 形状变更
或登录页。ADR-0038 同时禁止记录原始返回正文。

## 决策

1. 未知响应只保留固定白名单诊断：HTTP 状态、规范化 Content-Type、响应字节数、
   响应类型（空、HTML、JSON 或文本）、SHA-256、可识别 JSON 字段名和登录/验证码/跳转信号。
2. 不记录原始响应、HTML 标题、JSON 字段值、API Key、文章内容、联系人或联系方式。
3. Publisher 对诊断再做一次严格结构校验，非白名单字段一律丢弃，并执行现有敏感信息脱敏。
4. 诊断写入 `publish_attempts.response_json`、`publish_jobs.last_error_json` 和
   `lieju_api_publications.last_error_json`；SHA-256 同时写入现有 `response_hash` 字段。
5. 诊断不改变成功判定、未知态、人工对账或禁止盲目重投的规则。

## 兼容性

- 使用现有 JSONB 和 `response_hash` 字段，无数据库迁移、公开 API、Web 或配置变更。
- 旧失败记录不回填诊断；只有部署后新发生的列举网未知响应会保留诊断。

## 验收

- HTML 未知响应可保留类型、字节数、Content-Type、登录信号和 SHA-256。
- 伪造的 `raw_response` 和 API Key 不进入任务、尝试或提交记录。
- 原有成功、明确拒绝和禁止自动重投行为保持不变。
