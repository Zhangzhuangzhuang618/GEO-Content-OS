# 发布冻结资料

- `release-manifest.json`：机器可读的 v2.1 门禁、冻结哈希和任务范围。
- `DEVELOPMENT_FREEZE_v2.1.md`：开发冻结签字规则、证据和边界。
- `ROLLOUT_AND_ROLLBACK.md`：两阶段灰度、全局熔断和回滚操作卡。

完整验收命令为 `pnpm verify && pnpm release:check`。成功只代表开发冻结版通过自动门禁，不代表已执行或批准生产发布。
