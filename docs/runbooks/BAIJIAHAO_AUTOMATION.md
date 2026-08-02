# 百家号自动化与托管浏览器运行手册

适用范围：ADR-0028 / T145。本文只描述部署和受控灰度，不授权操作生产账号；首次生产启用必须由发布管理员在 Web 端确认策略和扫码登录。

## 1. 必要配置

```dotenv
BAIJIAHAO_BROWSER_GATEWAY_TOKEN=<至少32位随机内部密钥>
PUBLISHING_CREDENTIAL_KEY_BASE64=<32字节随机值的Base64>
PUBLISHING_CREDENTIAL_KEY_VERSION=<稳定版本名>
BAIJIAHAO_BROWSER_HEADLESS=true
BAIJIAHAO_BROWSER_SIMULATOR=false
```

网关端口 `9095` 不映射到宿主机或公网。API 和 Publisher 通过 Compose 内网访问；密钥不得使用百度密码，也不得写入日志。`PUBLISHING_CREDENTIAL_KEY_BASE64` 必须与已有平台凭证使用的密钥一致，否则历史凭证和加密登录状态无法解密。

## 2. 部署顺序

1. 备份 PostgreSQL，确认当前迁移版本和 Git 提交。
2. 构建 `api`、`web`、`ai-worker`、`publisher-worker`、`outbox-relay` 和 `baijiahao-browser`。
3. 先运行 `migrate`，确认 `0041_baijiahao_automation.sql` 成功。
4. 启动上述服务，检查 API、AI、Publisher、Outbox 和浏览器节点健康状态。
5. 在 Web 的百家号账号面板扫码。二维码只在响应和当前页面短暂显示，不落库。
6. 会话为 `authenticated` 后再保存并启用策略。首轮只启用一个账号，目标数设为 1，串行观察完整审核结果。

不要修改或清空 `official_site_automation_*`、`official_site_daily_*` 表。百家号策略停用只停止新候选，不删除历史内容、质量报告或发布尝试。

## 3. 内容来源

- `official_site_derived`：默认。仅在官网自动化 API 发布成功且有 URL 后派生；只复用事实、引用和核心观点，不重新检索。来源不适合时记录 `skipped`。
- `independent`：使用项目知识和品牌资料独立生成。
- `independent_fallback_enabled`：默认关闭。开启时，派生策略最早在首条排期前一小时补足缺口，不会降低门禁或超过候选上限。

官网发布失败、手工导出或缺少公开 URL 均不得触发派生。百家号失败不得修改官网任务状态。

## 4. 登录和人工接管

状态含义：

- `login_required`：尚未扫码或二维码已过期；
- `qr_ready`：等待扫码；
- `authenticated`：可启用自动化；
- `reauth`：Cookie 失效，需要重新扫码；
- `attention_required`：验证码、风控或页面签名变化，必须人工检查；
- `disabled`：账号已停用。

系统不保存账号密码，不识别或绕过验证码。容器中的 Profile 位于 `tmpfs`，重启后使用数据库中的加密 storage state 恢复。截图存入对象存储并按租户、账号和发布记录隔离。

## 5. 发布与素材

发布前冻结标题、正文、摘要、标签、分类、内容指纹和载荷哈希。引用 URL 只保留在服务端证据链，不写入公开稿。文章引用图片时，媒体资产必须：

- 属于同一租户、工作区和项目；
- `metadata_json.content_version_id` 等于本次内容版本；
- `metadata_json.promotional_watermark` 为字符串 `false`；
- MIME 为 PNG/JPEG/WebP/GIF，单张不超过 10 MB、合计不超过 50 MB；
- 下载内容大小和 SHA-256 与数据库记录一致。

不满足任一条件即停止。没有合格图片时走无封面，不会用外链图片或临时抓取图片代替。原创声明采用保守的“非原创”选项，不自动作权利保证。

## 6. 未知态和审核同步

提交前先创建 `baijiahao_browser_publications`。网络中断或页面没有确定结果时进入 `unknown`，两分钟宽限期内禁止再次点击。后续先进入内容管理页按账号、标题、内容指纹和提交时间核验；找到唯一内容后关联远端 ID，确认不存在后才允许用原幂等键重试，多义或无法核验进入 `manual_required`。

Publisher 定时同步 `processing | published | failed | unknown`。只有 `published` 才完成发布任务；最多 12 次审核核验或 3 次自动发布尝试后停止自动操作。

## 7. 只读诊断

```sql
SELECT id, account_id, status, last_verified_at, qr_expires_at, version
FROM baijiahao_browser_sessions
ORDER BY updated_at DESC;

SELECT id, policy_id, source_mode, status, rewrite_count, source_similarity,
       source_content_version_id, content_version_id, publish_job_id, last_error_json
FROM baijiahao_automation_runs
ORDER BY created_at DESC
LIMIT 50;

SELECT id, account_id, publish_job_id, status, external_post_id, external_url,
       submitted_at, last_reconciled_at, review_reason
FROM baijiahao_browser_publications
ORDER BY created_at DESC
LIMIT 50;
```

不得查询或导出 `storage_state_ciphertext`、平台账号凭证、Cookie 或二维码数据。

## 8. 回滚

1. 在 Web 中将百家号策略 `enabled` 和 `daily_enabled` 关闭。
2. 停止 `baijiahao-browser`；Publisher 的其他平台能力继续运行。
3. 保留百家号表、质量报告、发布尝试和截图以便审计，不回滚或删除官网表。
4. 对 `unknown`、`processing` 或 `manual_required` 任务先在百家号后台核验，禁止直接重试。
5. 修复并通过本地仿真、PostgreSQL 集成和回归测试后，再按单账号目标 1 重新灰度。
