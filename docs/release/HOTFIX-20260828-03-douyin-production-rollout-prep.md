# HOTFIX-20260828-03 抖音生产上线准备

## 根因

1. T158 已在 Compose 中增加 `douyin-browser` 及必填内部网关令牌，但 Windows 部署脚本仍停留在
   T157 服务清单，既不生成令牌，也不启动或等待该 Worker。
2. Windows 部署脚本无条件执行冻结版演示 Seed，生产部署缺少明确的跳过入口。
3. Release static gate 通过匹配 `PROJECT_CONTEXT.md` 的旧中文句子保护基线；表数和端点数更新后，
   即使冻结 DOCX、迁移和 OpenAPI 均未漂移，门禁仍会必然失败。
4. 生产使用未提交的 Compose override；仓库脚本未把“基础 Compose + 可选 override”作为统一参数。

## 修复

1. Windows 部署脚本仅在 `DOUYIN_BROWSER_GATEWAY_TOKEN` 缺失或留空时生成 32 字节安全随机十六进制
   令牌，不覆盖现有值，也不输出令牌正文。
2. 部署和健康等待清单加入 `douyin-browser`；所有 Compose 操作统一加载基础文件，并在
   `infra/compose.override.yaml` 存在时追加该 override。
3. 新增显式 `-SkipSeed` 参数；只有未指定时才执行冻结版演示 Seed。Owner 初始化保持独立控制。
4. Release static gate 继续校验五份冻结 DOCX 的 SHA-256、T001–T144 清单和全部发布门禁命令；
   表、迁移、端点、页面和六个 Skill 改从迁移 SQL/日志、生成 OpenAPI、可访问性页面清单及实际目录
   核验。冻结迁移 0030 必须为 57 张表，当前迁移必须按 0052→0053 收尾并得到 92 张表，OpenAPI
   必须为 169 个公开端点。
5. 增加静态部署脚本回归和 `release:check:static` 快速入口；完整 `release:check` 默认行为及十二项质量
   门禁不变。
6. 全新数据库迁移测试显式核对迁移文件和 Drizzle journal 一一对应，并断言最后两步为 0052、0053。

## 不变边界

- 不修改五份冻结 DOCX，不降低冻结质量门槛，不改变 T001–T144 的静态授权范围。
- 不修改数据库结构、公开 API、Seed 内容或发布状态机。
- 不读取、替换或记录现有生产密钥；`DOUYIN_BROWSER_GATEWAY_TOKEN` 是服务间内部令牌，不是抖音账号
  密码。
- 本 Hotfix 只完成代码、测试和发布准备，不拉取生产代码、不迁移生产数据库、不重建生产容器。

## 验证

- Node.js 22 下 Windows 部署脚本静态回归 4/4 通过，覆盖抖音令牌、服务清单、健康等待、`-SkipSeed`
  和可选 Compose override。
- 基础 Compose `config --quiet` 通过并包含 `douyin-browser`；生产现有基础 Compose 与未提交 override
  的只读合并解析通过。
- Release static gate 通过，五份冻结 DOCX SHA-256、T001–T144、57/92 表、0052→0053、169 端点、
  32 页面和六个 Skill 均匹配。
- 全新、可销毁 PostgreSQL 迁移套件 1 个文件、7 个用例通过，最终为 92 张业务表；未使用本机现有
  漂移数据库。
- Douyin Browser Worker 单元测试 4 个文件、18 个用例通过；本地仿真集成测试 1 个文件、7 个用例
  通过。
- API 单元测试 50 个文件、273 个用例通过；Web 单元测试 7 个文件、21 个用例通过；AI Worker
  21 个文件、199 个用例通过；Publisher 单元测试 4 个文件、10 个用例和数据库集成 19 个用例通过；
  Outbox Relay 单元测试 4 个文件、11 个用例通过。
- `pnpm verify` 在 Node.js 22 下完整通过：格式、Lint、全仓类型检查、单元测试、Contracts/API/平台
  契约测试和 API 集成测试；API 集成为 56 个文件、289 个用例。
- Web 生产构建通过。
