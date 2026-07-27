# ADR-0024：官网当日批次人工重发

- 状态：已批准实施
- 日期：2026-07-27
- 影响范围：仅 `official_site`
- 前置决策：ADR-0021、ADR-0023

## 1. 问题

ADR-0023 规定每个当日批次最多尝试 30 篇候选。候选耗尽仍未补足 10 篇时，批次进入 `attention_required`，但原系统没有正式恢复入口，只能等待次日或直接修改数据库。

## 2. 决策

1. 发布管理员可以对当日因 `DAILY_CANDIDATE_LIMIT_REACHED` 停止的批次执行“重新发起今日批次”。
2. 原批次改为 `cancelled`，文章、质量结果、失败原因和审计记录全部保留。
3. 系统为同一策略和业务日期创建下一 `attempt_no` 的新批次；新批次从 0 开始，仍以 10 篇为目标、最多尝试 30 篇候选。
4. 不继承旧批次中未形成完整发布计划的合格候选，避免跨批次混合状态和重复排期。
5. 质量阈值、单篇最多重写 3 次和官网发布最多重试 3 次保持不变。
6. 同一策略、同一业务日期、同一时刻最多存在一个 `running` 或 `scheduled` 批次。
7. 请求必须携带 `Idempotency-Key` 和当前批次 `expected_batch_version`；重复请求不创建重复批次，并发旧版本请求失败。
8. 前置资料缺失、当天已结束、正在运行、已排期或已完成的批次不允许人工重发。

## 3. 数据库

迁移 `0040_official_site_daily_batch_attempts`：

- `official_site_daily_batches` 增加正整数 `attempt_no`，历史记录默认为 1；
- 唯一约束改为 `(tenant_id, policy_id, business_date, attempt_no)`；
- 增加部分唯一索引，限制同一策略和业务日期只能有一个活动批次；
- 不新增表，不删除历史数据。

## 4. API

新增：

`POST /platform-accounts/{id}/official-site-automation/daily-batch/restart`

请求：

```json
{
  "project_id": "UUID",
  "expected_batch_version": 4
}
```

权限沿用 `publishing.manage / publisher_or_admin`，幂等策略为 `key+body_hash`。成功返回更新后的 `OfficialSiteAutomationPolicyView`，其中今日批次包含 `attempt_no`、`version` 和服务端计算的 `restart_allowed`。

## 5. UI

只有当前批次确因 30 篇候选耗尽而停止时，页面才显示“重新发起今日批次”。执行前明确提示：

- 原记录会保留；
- 将创建下一次当日尝试；
- 新尝试会产生新的 AI 调用成本；
- 不降低质量标准。

成功后页面切换到新的尝试编号和实时进度。

## 6. 明确不做

1. 不允许用户重发任意状态或任意历史日期的批次。
2. 不删除、重置或复用旧批次及旧候选。
3. 不增加候选上限，不降低门禁，不绕过质检。
4. 不改变其他六个平台流程。
5. 不自动无限重发；每次新尝试必须由有权限的用户明确发起。
