# 官网自动质检、重写与发布运行手册

## 前置条件

- PostgreSQL 已执行至迁移 0040；
- API、Outbox Relay、AI Worker、Publisher Worker、Redis 正常；
- AI Worker 配置 DeepSeek，质量检查和重写使用 `deepseek-v4-pro`；
- 官网项目已部署 `/api/geo/v1`，使用数据库副本完成过验证；
- GEO 平台账号为 `official_site + api + active`，凭证包含 `base_url` 和 `bearer_token`；
- 项目已发布品牌档案，且内容生成所需 Brief、平台规则和知识资料可用。

## 必需配置

```text
AI_MODEL_DRIVER=deepseek
DEEPSEEK_API_KEY=<secret>
CONTENT_MODEL_QUALITY_KEY=deepseek-v4-pro
QUALITY_CHECKER_MODEL_KEY=deepseek-v4-pro
CONTENT_WRITER_PROMPT_VERSION_ID=25000000-0000-4000-8000-000000000008
QUALITY_CHECKER_PROMPT_VERSION_ID=25000000-0000-4000-8000-000000000007
PUBLISHING_CREDENTIAL_KEY_BASE64=<32-byte-base64>
PUBLISHING_CREDENTIAL_KEY_VERSION=<stable-version-name>
PUBLISHER_WORKER_CONCURRENCY=2
PUBLISHER_STALE_AFTER_MS=120000
OFFICIAL_SITE_DAILY_TICK_MS=30000
```

不得在已有加密平台凭证后直接替换加密密钥。密钥轮换必须先完成凭证重加密。

## 平台账号凭证

在“发布 → 管理平台账号”创建或编辑官网账号：

- 交付模式：API；
- Base URL：官网 API 的完整根地址，例如预发布环境 `https://staging.example/api/geo/v1/`；路径前缀会被保留，不能只填写域名；
- Bearer Token：与官网 `GEO_PUBLISH_TOKEN_SHA256` 对应的原始令牌；
- 状态：启用。

生产和预发布 Base URL 必须使用 HTTPS；只有 `localhost`、`127.0.0.1`、`::1` 本地联调允许 HTTP。保存后执行能力测试，必须返回 `publish=true`、`get_status=true`。不得用生产官网做本地测试。

## 启用策略

在官网账号下选择项目并启用自动发布。阈值和次数由数据库约束固定，UI 不允许修改：85/90/90/85/80/80，最多重写 3 次，最多发布 3 次。

如需每天自动发布 10 篇，同时开启“每天自动生产并排期发布 10 篇”。系统每天 00:00 开始准备内容，不合格候选自动补位，最多尝试 30 篇；凑足 10 篇后按页面列出的十个北京时间排期。项目必须已有官网关键词、已发布品牌资料、已发布官网规则、已解析知识资料和 active API 官网账号。缺少前置资料时页面会显示原因；补齐后 AI Worker 会在下一次巡检自动继续。

如果 10 篇内容在部分固定时段之后才准备完成，系统把已错过的时段顺延到当天剩余时间，且不会创建过去时间或跨日补发任务。

当今日批次已尝试 30 篇仍未补足 10 篇时，页面显示“重新发起今日批次”。确认后旧批次和候选记录保留，新建下一尝试编号的批次；新批次仍最多尝试 30 篇且质量阈值不变。前置资料缺失、当天已结束、运行中、已排期或已完成的批次不提供该按钮。

## 状态解释

| 自动化状态 | 含义 | 操作 |
|---|---|---|
| `quality_pending` | 等待或正在机器检查 | 查看质量运行；不要重复创建检查 |
| `rewrite_pending` / `rewriting` | 等待或正在按问题重写 | 等待 Worker；失败会自动重试 |
| `publishing` | 质量通过，正在发布官网 | 查看发布任务与尝试记录 |
| `published` | 官网已确认发布 | 使用外部 URL 验证文章 |
| `manual_required` | 三次重写仍不通过或重写执行连续失败 | 人工编辑后重新检查质量 |
| `publish_failed` | 官网发布三次仍失败或确定性拒绝 | 修复官网/凭证后在发布任务重试；总次数不超过 3 |
| `disabled` | 策略、账号或任务被人工停用/取消 | 确认原因后重新启用策略并重新生成或检查 |

每日批次状态：`running` 表示正在生成、质检或补位；`scheduled` 表示 10 篇均已排期；`completed` 表示 10 篇均已发布；`attention_required` 表示候选达到 30 篇、当天已结束或前置资料缺失。

## 重试规则

- AI 重写：质量不通过最多生成 3 个新版本；Worker 执行错误也最多尝试 3 次后转人工；
- 官网发布：网络错误、5xx、能力探测暂时失败可自动重试，总调用次数最多 3；
- 4xx `PUBLISH_REJECTED` 是确定性拒绝，立即停止；
- 所有发布重试复用原幂等键；状态未知时不得创建新内容版本规避幂等。

## 诊断查询

```sql
SELECT id, variant_id, content_version_id, status, rewrite_count,
       last_error_json, publish_job_id, updated_at
FROM official_site_automation_runs
ORDER BY updated_at DESC
LIMIT 20;

SELECT id, content_version_id, status, attempt_count, origin,
       external_post_id, external_url, published_at, last_error_json
FROM publish_jobs
WHERE origin = 'official_site_automation'
ORDER BY updated_at DESC
LIMIT 20;

SELECT publish_job_id, attempt_no, status, error_code, created_at
FROM publish_attempts
ORDER BY created_at DESC
LIMIT 50;

SELECT batch.business_date, batch.attempt_no, batch.status, batch.last_error_json,
       count(item.id) AS attempted,
       count(item.id) FILTER (WHERE item.status='published') AS published,
       count(item.id) FILTER (WHERE item.status='retired') AS retired
FROM official_site_daily_batches AS batch
LEFT JOIN official_site_daily_batch_items AS item
  ON item.batch_id=batch.id AND item.tenant_id=batch.tenant_id
GROUP BY batch.id
ORDER BY batch.business_date DESC, batch.attempt_no DESC;
```

不得把凭证密文、Bearer Token 或 DeepSeek Key 输出到工单和日志。

## 安全停机与回滚

1. 在 UI 关闭项目的官网自动发布策略，阻止后续生成进入自动流程；
2. 停止 `publisher-worker`，阻止已排期任务发出远程调用；
3. 不删除自动化运行、质量报告、发布任务、尝试记录或 Outbox 事件；
4. 如需回滚代码，数据库新增列和表保持兼容，不做破坏性降级；
5. 已发布官网文章不自动删除，需在官网后台人工处理。

## 本地验收边界

本地 E2E 使用官网 SQLite 副本、临时令牌和本地 HTTP 地址。验收必须验证：质量失败触发重写、第三次失败转人工、质量通过只新增一篇文章、重复消息不重复文章、官网临时失败最多三次、成功结果回写发布任务。禁止调用生产官网接口。
