# v2.1 灰度与回滚操作卡

## 前置条件

只有 `pnpm verify && pnpm release:check` 在待发布提交上连续通过，且变更审批、备份可恢复点、监控和当班负责人均已确认，才可进入生产灰度。本操作卡不授权执行生产动作。

## 灰度顺序

1. 保持 `GEO_PUBLISHING_KILL_SWITCH=true`，部署应用和数据库兼容变更，完成只读烟测。
2. 将全局 kill switch 解除，但七个平台旗标仍保持关闭，确认无意外发布任务。
3. Phase 1 仅允许 `official_site`、`zhihu`、`xiaohongshu`。先按租户白名单开启，观察发布成功、P95、失败率、成本、安全告警和队列积压。
4. 只有 `platform-rollout.v1.json` 中全部冻结门禁持续满足，且 Phase 1 无未决未知发布状态，才可审批 Phase 2。
5. Phase 2 才允许 `baijiahao`、`toutiao`、`wechat_mp`、`douyin`；继续按租户白名单逐步开启。

缺少指标、观测窗口未完成、外部平台状态未知或任一门禁失败时，不得扩大流量。

## 回滚

1. 立即设置 `GEO_PUBLISHING_KILL_SWITCH=true`，停止领取新的真实发布任务。
2. 关闭受影响的逐平台旗标；保留导出能力和已写入的 append-only 尝试记录。
3. 对外部状态未知的尝试只做查询/人工核对，不盲目重试。
4. 应用采用蓝绿/滚动方式退回上一兼容版本。数据库只执行已验证的安全回滚；不得删除已产生的业务数据。
5. Prompt/Schema 问题通过切回历史 `prompt_version_id` 或规则版本处理，不覆盖历史版本。
6. 若涉及数据损坏，按 `docs/runbooks/backup-and-restore.md` 在隔离环境恢复并完成校验，未经事故指挥批准不得切换流量。
7. 保存 request_id、tenant_id、job_id、run_id、发布尝试、旗标变更和审计证据，完成复盘后才能重新申请灰度。
