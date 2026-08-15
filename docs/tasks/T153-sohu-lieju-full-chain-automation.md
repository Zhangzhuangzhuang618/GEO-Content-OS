# T153：搜狐号与列举网全链路自动化

- 状态：已完成
- 决策：ADR-0037
- 依赖：T145、T148、T150、T151、T152

## 交付物

- 搜狐号、列举网独立日批策略与管理入口。
- 自动生文、冻结质检、按报告最多三次重写、自动配图和排期。
- `sohu_automation`、`lieju_automation` 发布状态与每日批次对账。
- 列举网合规推广内容约束和确定性阻断。

## 文件范围

- `packages/contracts/`
- `packages/skills/content-writer/`
- `apps/api/src/database/migrations/`
- `apps/api/src/modules/publishing/`
- `apps/web/src/features/pub-01/`
- `workers/ai/`
- `workers/publisher/`
- `docs/adr/`、`PROJECT_CONTEXT.md`

## 验收

1. Contracts 118、API 发布模块 72、AI Worker 123、Publisher 数据库集成 13、Web 单元 9
   项通过。
2. Contracts、API、AI Worker、Publisher、SDK 类型检查及 API、AI Worker、Publisher、Web
   生产构建通过；OpenAPI/SDK 155 个业务接口一致。
3. 迁移从空库执行通过，共验证 86 张业务表以及租户、平台、账号和状态约束。
4. 受影响源码 ESLint、Prettier 和 `git diff --check` 通过。宿主机为 Node 24，不满足仓库锁定的
   Node 22，因此未直接运行聚合命令 `pnpm verify`；其相关受影响检查已按 Node 工具逐项执行。
5. 自动测试只使用本地数据库和仿真发布响应；未操作生产官网，也未执行真实第三方发布。
