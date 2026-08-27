# T157：问天GEO薄连接器

- 状态：已完成（连接器范围）
- 决策：ADR-0071
- 依赖：ADR-0022、问天 `wentian-geo-connector@1`

## 交付物

1. GEO连接器配置、项目binding和最近同步状态的数据迁移。
2. 服务端签名客户端，支持绑定申请、状态查询、撤回、断开、一次性登录票据和问题集同步。
3. 租户/项目权限门禁和不泄露连接器密钥的API。
4. GEO轻量连接状态页；完整实验、报告和配置继续由问天Web提供。
5. 问天不可达、重放、错租户、错项目、未知角色和幂等测试。

## 文件范围

- `apps/api/src/modules/integrations/wentian/`
- `apps/api/src/database/migrations/0052_wentian_geo_connector.sql`
- `apps/web/src/features/anl-05/`
- `packages/contracts/`
- `docs/integrations/wentian/`、`docs/adr/`

## 验收命令

```bash
pnpm --filter @geo-content-os/contracts test
pnpm --filter @geo-content-os/api test
pnpm --filter web build
pnpm verify:openapi
pnpm lint
```

## 发布边界

部署前配置问天公开HTTPS地址、连接器实例ID和服务端密钥；没有配置时连接器页面明确显示“未配置”，不得影响GEO其余功能。

## 完成记录

- 完成日期：2026-08-23；
- 交付：迁移0052、6个公开API、服务端签名客户端、项目绑定/刷新/断开、一次性进入问天、问题集同步和GEO轻量页面；
- 迁移：2026-08-27再次从全新PostgreSQL演练通过（7/7），当前共89张表；
- 契约：OpenAPI与SDK共166个业务操作，一致性检查通过；
- 专项验证：API 16项、Web Playwright 4/4、问天侧真实跨系统闭环均通过；
- 全量验证：2026-08-27在干净运行环境重跑，类型检查、单元测试、契约测试、Web生产构建、OpenAPI/SDK一致性和连接器范围格式/Lint均通过；全仓格式/Lint仍受用户文件与既有临时调试文件影响，未改动这些文件；
- 集成测试：2026-08-27重跑后56/56个文件、289/289项全部通过，原9个资源超时不再复现。
