# ADR-0001：开发冻结基线 v2.1 契约修订

- 状态：已授权
- 日期：2026-07-15
- 决策人：项目所有者
- 适用范围：GEO Content OS T046–T144 未完成任务
- 上一基线：v2.0 / 2026-07-13

## 背景

执行 T046–T144 时发现 v2.0 的产品要求、API 清单、数据库手册和任务文件范围存在不可同时实现的缺口。项目所有者已明确授权扩展相关任务范围、修正冻结契约和迁移，并要求继续逐任务实现、测试、提交、推送和创建不自动合并的 PR。

当前未完成任务为 T073、T077、T082–T098、T100–T102、T123–T126、T132、T135–T136、T139–T144。

## 决策

### 1. 版本与事实源

- 新冻结版本为 `v2.1 / 2026-07-15 / 全面开发冻结修订版`。
- v2.0 保留为只读历史基线；五份修订 DOCX 生成到 `docs/freeze-v2.1/`。
- 可执行事实源优先级保持不变：contracts > migrations > generated OpenAPI > 冻结说明文档。
- 任务编号仍为 T001–T144，不新增 T145 以后任务。

### 2. 数据库基线

数据库基线由 56 表修订为 57 表：

- 补齐冻结手册已定义但迁移遗漏的 `subscriptions`。
- 补齐冻结手册已定义但迁移遗漏的 `model_rate_cards`。
- 新增 `analytics_export_jobs`，用于 `/analytics/export` 的异步任务状态、查询哈希、对象地址、错误和保留期；不得复用语义不同的租户全量导出或平台内容导出表。
- 为 `memberships`、`platform_accounts`、`publish_jobs` 增加整数 `version` 乐观锁字段，以满足可变资源响应和 `resource+version` 幂等约定。
- T142 文件范围扩展为允许新增纠正迁移，但不得重写已有迁移历史。

### 3. API 基线

冻结 API 由 103 个修订为 114 个。新增端点：

1. `GET /keyword-sets`
2. `GET /keyword-sets/{id}`
3. `POST /platform/tenants/{id}/restore`
4. `GET /platform/prompt-versions`
5. `POST /platform/prompt-versions`
6. `POST /platform/prompt-versions/{id}/publish`
7. `POST /platform/prompt-versions/{id}/retire`
8. `GET /platform/rule-versions`
9. `POST /platform/rule-versions`
10. `POST /platform/rule-versions/{id}/publish`
11. `POST /platform/rule-versions/{id}/retire`

现有 `/analytics/export` 保留，返回 `AnalyticsExportJobView`，由 `analytics_export_jobs` 承载。

### 4. 产品口径修订

- STR-04 的关键词唯一性改为“关键词集内规范化 term 唯一”，与 `keywords(keyword_set_id, lower(term))` 约束一致；项目可以通过不同关键词集保留不同策略版本。
- CONT-01 移除 Brief“归档”动作。Brief 继续使用 `draft | ready`，历史保留通过内容包和审计实现；复制通过读取后创建新 Brief 完成。
- SET-01 的成员列表、改角色、禁用、恢复必须由正式成员 API 支持；最后一个 active tenant owner 不可降级或禁用。
- SET-03 使用新增的平台 Prompt/规则版本 API；发布版本不可覆盖，只能新建版本或退役。
- PLAT-01 使用新增租户恢复 API，暂停和恢复均写审计。

### 5. 任务范围修订

- T077 增加 `packages/contracts/src/api/keywords*` 与关键词查询 API 范围。
- T098 增加成员 contracts、成员 API 和 membership version 迁移范围。
- T100 增加平台 Prompt/规则 contracts、API 和必要迁移范围。
- T102 增加平台租户恢复 contracts/API 范围。
- T123 增加 publishing accounts contracts 与 `platform_accounts.version` 迁移范围。
- T124 增加 publishing jobs contracts 与 `publish_jobs.version` 迁移范围。
- T126 继续负责发布聚合契约、OpenAPI 和 mock E2E。
- T132 增加 `analytics_export_jobs` 迁移、worker/outbox 接口及 Analytics contracts 范围。
- T142 增加纠正迁移、完整演示种子和迁移验证脚本范围。
- 其余任务的目标和验收命令保持不变。

## 不采用的方案

- 不让 Web 页面依赖硬编码或仅测试 mock 来规避缺失 API。
- 不把 Analytics 导出伪装成 `tenant_export_jobs` 或带 content version 的 `export_artifacts`。
- 不为 Brief 增加仅服务列表页面的第三种状态。
- 不在旧 migration 文件中追加变更；使用新的顺序迁移保持升级可审计。

## 验收

- v2.1 五份 DOCX、PROJECT_CONTEXT、CLAUDE、contracts、迁移和生成 OpenAPI 数量一致。
- 57 张业务表全部由空库迁移创建。
- 114 个端点全部进入 contracts 和 OpenAPI 3.1。
- 32 个页面全部存在并通过 T140 可访问性验收。
- T139–T144 的固定命令全部通过后才允许签署开发冻结。
- 所有 PR 不自动合并；不执行生产部署或真实平台发布。
