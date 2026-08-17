# HOTFIX-20260817-05 搜狐号与列举网日批生成运行时修复

## 生产证据

- 两次列举网“重试今日批次”请求均返回 200，两个批次也确实重新激活，因此失败不在管理入口。
- 两个批次共创建 60 个候选，全部在生成阶段失败并转为 `GENERATION_FAILED_RETIRED`，没有生成内容版本或发布任务。
- Master 阶段反复出现 `SKILL_TOOL_ARGUMENTS_INVALID`，错误路径为 `/platform_code`；模型请求读取 `lieju` 平台规则时，被 `get_platform_rules` 的旧枚举拒绝。
- Variant 阶段出现 PostgreSQL 错误：`outbox_events.available_at` 不存在。数据库初始迁移及其他 Outbox 写入统一使用 `next_attempt_at`。

## 根因

1. 通用平台列表已经包含 `sohu` 和 `lieju`，但 Skill 工具定义仍维护一份手写的七平台枚举，新增平台时发生漂移。
2. 搜狐号与列举网共用的自动化写入 Outbox 时使用了不存在的 `available_at` 列；该路径此前缺少对实际 SQL 列名的回归覆盖。

## 修复

- `get_platform_rules` 直接复用 Contracts 的 `PLATFORM_CODES`，不再单独维护平台枚举。
- 增加覆盖全部九个平台的 SchemaGuard 测试，明确验证 `sohu` 与 `lieju` 可读取冻结平台规则。
- 浏览器平台自动化统一写入 `outbox_events.next_attempt_at`。
- 增加 Outbox SQL 回归，禁止该路径重新引入 `available_at`。

## 安全边界

- 不修改冻结质量门禁、候选上限、重写次数、平台规则内容或模型结论。
- 不重新评估旧内容或旧质量报告，不自动恢复已经耗尽的历史批次。
- 本 Hotfix 不修改生产数据库，也不操作搜狐号、列举网或其他生产平台。

## 部署与批次恢复

- 重新构建并部署 AI Worker；无需数据库迁移，API、Web、Publisher 和浏览器 Worker 无需因本 Hotfix 重建。
- 日志中的两个 2026-08-17 批次已经达到 30 个候选上限，部署代码不会自动重置它们。次日新批次会直接使用修复后的代码。
- 如必须在 2026-08-17 当天恢复，需要在部署完成后另行授权并设计一次性、可审计的数据恢复；不得直接删除历史候选或伪造合格结果。
