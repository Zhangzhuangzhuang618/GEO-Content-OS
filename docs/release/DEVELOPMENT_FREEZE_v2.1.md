# v2.1 开发冻结签字

基线：v2.1 / 2026-07-15。任务范围：T001–T144。此签字只确认开发冻结门禁，不授权生产部署、生产迁移或真实平台发布。

## 签字规则

在干净工作区、Node.js 22 和可用 Docker/Playwright 环境中，以下命令连续返回 0，即构成机器可审计的开发冻结签字：

```text
pnpm verify && pnpm release:check
```

任一命令失败，签字自动失效。不得删减 `docs/release/release-manifest.json` 中的门禁后继续声称冻结完成。

## 门禁与证据

| 范围 | 冻结要求 | 自动证据 |
|---|---|---|
| 版本 | contracts、Migration、OpenAPI、Prompt/Schema、DOCX、PROJECT_CONTEXT 一致 | 冻结文件 SHA-256、OpenAPI 生成检查、contracts/Schema 测试 |
| 功能 | Mock Brief 到七变体、质量、审核、API 发布/导出、指标闭环 | AC-001–AC-016 system E2E |
| 数据 | 57 表、空库 migration+seed、升级/回滚 smoke、append-only 与跨租户约束 | migration Testcontainers 套件与全量集成测试 |
| 安全 | 租户隔离、support grant、SSRF、CSRF、XSS、注入、凭证和导出阻断项为 0 | T138 安全矩阵 |
| 可靠性 | Outbox 可恢复、未知发布不盲重试、PostgreSQL WAL 可恢复 | chaos、publisher、restore drill |
| 质量 | 六 Skills 与 RAG 冻结阈值通过，伪造引用为 0 | `pnpm eval:all` |
| 成本 | 固定七平台 Brief 的加权 token 成本相对冻结基线回归不超过 15% | `brief-cost-estimator.test.ts` |
| 性能 | API/RAG P95 不超过 800ms，队列入队不超过 2s，100 工作区 | T139 k6 报告 |
| 体验 | 32 页面 serious/critical 可访问性问题为 0 | T140 Playwright + axe |
| 运维 | 告警、仪表盘、RPO 不超过 15m、RTO 不超过 60m | observability verifier 与 T137 恢复证据 |
| 灰度 | 官网/知乎/小红书先行，之后才允许其余四平台；默认全关 | feature flag manifest 与验证器 |

## 签字边界

- 本地 Testcontainers 恢复演练证明备份/WAL/恢复链路可执行；生产 RPO/RTO 仍必须由生产同构环境的定期演练证明。
- k6 本地 fixture 证明负载脚本、100 工作区和阈值判定可执行；它不代表未测试的生产容量。
- 所有生产平台旗标保持关闭。开启旗标、配置真实凭证、切生产流量和执行生产迁移均需独立审批。
- 冻结后任何状态、权限、表、公开 API、Prompt 或 Schema 变化必须新增 ADR/变更单并重跑全部门禁。
