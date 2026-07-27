# GEO Content OS 文档中心

## 当前冻结版本

- 版本：v2.1（全面开发冻结修订版）
- 基线日期：2026-07-15
- 全局入口：`../PROJECT_CONTEXT.md`
- Claude Code 指令：`../CLAUDE.md`
- 冻结文档：`freeze-v2.1/`

## 使用方式

1. Claude Code 启动时由根目录 `CLAUDE.md` 导入 `PROJECT_CONTEXT.md`。
2. 首次会话完整读取五份冻结文档并完成全局认知验收，不修改代码。
3. 后续按 T001–T144 逐项开发，每次只读取当前任务卡及相关冻结文档。
4. 冻结文档只读；修改产品、契约、数据库或任务口径必须先形成变更决策，再发布新的冻结版本目录。
5. `archive/` 只保存历史或兼容副本，不属于当前事实源。

## 部署文档

- [Windows Docker Desktop 部署手册](deployment/WINDOWS_DEPLOYMENT.md)

## 可执行修正

- 冻结基线后的兼容修正记录在 `adr/`；当前有效范围为 ADR-0001 至 ADR-0023。
- [运行能力审计（2026-07-19）](runbooks/RUNTIME_CAPABILITY_AUDIT_2026-07-19.md) 记录页面到消费者、结果落库的真实接线状态。
- [官网自动质检、重写与发布运行手册](runbooks/OFFICIAL_SITE_AUTOMATION.md) 记录配置、状态、重试、诊断和回滚。

## 文档职责

| 文件 | 职责 |
|---|---|
| PRD产品需求文档.docx | 页面、字段、角色权限、业务流程和验收标准 |
| 技术设计文档（AI开发友好）.docx | 架构、API、RAG、队列、Adapter、部署和成本 |
| AI Skills & Prompt设计规范.docx | Skills、Prompt、Schema、Few-shot、Tool Calling 和七平台规则 |
| 数据库设计手册.docx | 冻结基线的 ER、57 张表、字段、索引、迁移和示例数据；当前可执行增量见 ADR-0023（65 张表） |
| Claude Code开发任务拆解.docx | T001–T144 的依赖、范围、验证命令和完成定义 |

## 冻结管理

- 不在 `freeze-v2.1/` 内直接修订文件；`freeze-v2.0/` 作为历史只读基线保留。
- 需要变更时先记录原因、影响面、兼容策略和迁移方案。
- 评审通过后建立新版本目录，并同步更新 `PROJECT_CONTEXT.md`、`CLAUDE.md` 和哈希清单。
