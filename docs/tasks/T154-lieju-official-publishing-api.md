# T154：列举网官方发布 API

- 状态：已完成
- 决策：ADR-0038
- 依赖：T151、T153

## 交付物

1. 列举网官方 API 的 GBK 表单传输、保守响应解析和公开链接核验。
2. API Key、广州区域和联系方式的加密账号配置及非回显管理界面。
3. `lieju_api_publications` 防重复提交记录和人工确认联动。
4. 旧浏览器网关兼容及搜狐号/列举网自动化来源修复。

## 文件范围

- `packages/adapters/platforms/lieju/delivery/`
- `apps/api/src/database/migrations/`
- `apps/api/src/modules/publishing/`
- `apps/web/src/features/pub-01/`
- `workers/publisher/`、`workers/lieju-browser/`、`workers/sohu-browser/`
- `PROJECT_CONTEXT.md`、`docs/adr/`

## 验收

1. 不调用真实列举网 API；使用本地仿真响应验证请求和状态语义。
2. 网络未知和消息重放不产生第二次官方提交。
3. API Key 不进入日志、响应或仓库。
4. 迁移、Adapter、API、Publisher、浏览器 Worker、Web 测试及生产构建通过。
