# ADR-0026：官网当日批次人工终止

- 状态：已批准实施
- 日期：2026-07-27
- 影响范围：仅 `official_site`
- 前置决策：ADR-0021、ADR-0023、ADR-0024

## 1. 问题

每日十篇批次可能因模型、队列或内容规则异常而持续占用候选额度和 AI 调用。现有页面只能等待批次结束，无法在用户已经确认异常时立即停止。

## 2. 决策

1. 发布管理员可以手动终止当天最新的 `running` 批次。
2. 终止后批次进入既有 `cancelled` 终态，调度器不再创建候选或排期。
3. 属于该批次且尚未完成的生成、质检和重写运行进入 `cancelled` 或 `disabled`，已投递的队列消息消费时按终态幂等退出。
4. 已经发出的模型请求无法从 API 进程强制撤回，可能仍产生当次调用费用，但其结果因运行租约失效而不能进入后续发布流程。
5. 仍在生成、质检或重写的候选进入 `retired`；已经合格但尚未排期的候选进入 `reserve` 并保留，不自动发布。
6. 已发布内容不回滚，已经排期的批次不允许使用此入口，继续使用发布任务自身的取消能力。
7. 当天被终止的批次不会自动恢复；只要每日计划仍开启，下一自然日照常创建新批次。
8. 请求必须携带 `Idempotency-Key`、项目 ID 和当前批次版本；重复请求不产生重复副作用，并发旧版本请求失败。

## 3. API

新增：

`POST /platform-accounts/{id}/official-site-automation/daily-batch/cancel`

请求：

```json
{
  "project_id": "UUID",
  "expected_batch_version": 7
}
```

权限沿用 `publishing.manage / publisher_or_admin`，幂等策略为 `key+body_hash`。成功返回更新后的 `OfficialSiteAutomationPolicyView`。

## 4. UI

只有今日批次为“正在准备”时显示“终止今日任务”。执行前明确提示：

- 停止补题和自动排期；
- 已发出的 AI 请求可能仍产生一次调用费用；
- 已合格内容保留但不会自动发布；
- 次日仍按每日计划运行。

成功后页面立即显示“已取消”、处理中数量为 0，并隐藏终止按钮。

## 5. 数据库

复用现有 `cancelled`、`retired`、`reserve`、`generation_runs.cancelled` 和 `official_site_automation_runs.disabled` 状态，不新增表、字段或迁移。

## 6. 明确不做

1. 不强制中断已经到达模型服务端的 HTTP 请求。
2. 不删除批次、候选、文章、质量报告、用量和审计记录。
3. 不取消已经排期或正在发布的任务。
4. 不改变其他六个平台流程。
