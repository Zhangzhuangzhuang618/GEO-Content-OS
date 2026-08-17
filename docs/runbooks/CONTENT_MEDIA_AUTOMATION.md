# 自动配图运行手册

## 启用前检查

1. Cloudflare 账号已开通 Workers AI，并由账号所有者接受
   `@cf/meta/llama-3.2-11b-vision-instruct` 的使用许可。
2. AI Worker、Publisher Worker、百家号、搜狐号和列举网浏览器进程均可访问私有 MinIO。
3. 推荐让官网发布 API 返回 `media_upload=true`：Publisher 会在发文前把 MinIO 中的 JPEG 二进制上传到
   官网，使用官网返回的 HTTPS 地址，不要求 Windows 或 MinIO 具备公网入口。
4. `GENERATED_MEDIA_PUBLIC_BASE_URL` 仅用于持久公开 CDN 回退。采用官网随文上传且没有公开 CDN 时留空；
   此时列举网官方 API 自动化会跳过配图并直接无图排期。
5. 不配置 Gemini；本链路没有 Gemini 环境变量或调用。

## 推荐配置

```dotenv
IMAGE_AUTOMATION_ENABLED=true
IMAGE_PLANNER_MODEL_KEY=deepseek-v4-flash
IMAGE_GENERATION_DRIVER=cloudflare
IMAGE_GENERATION_STEPS=4
IMAGE_PROVIDER_TIMEOUT_MS=120000
CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id>
CLOUDFLARE_API_TOKEN=<workers-ai-token>
CLOUDFLARE_IMAGE_MODEL=@cf/black-forest-labs/flux-1-schnell
CLOUDFLARE_IMAGE_QA_MODEL=@cf/meta/llama-3.2-11b-vision-instruct
GENERATED_MEDIA_PUBLIC_BASE_URL=
```

## 状态与诊断

- 配图不是等每日目标全部生成后统一执行。官网、百家号、搜狐号的每一篇内容通过最终质量门禁后，
  都会立即独立创建配图任务。列举网仅在配置了持久公网媒体地址时创建配图任务；否则直接无图排期。
- `content_media_runs.status=queued|running`：等待或正在处理。
- `succeeded`：两个正文场景均由 Cloudflare 生成并通过视觉门禁。
- `fallback`：至少一张使用模板，或有素材存储失败；文章仍按原流程排期。
- `diagnostics_json.provider_failures`：生成/视觉质检失败的脱敏原因。
- `diagnostics_json.storage_failures`：对象存储失败的脱敏原因。
- `content_media_assets`：实际可发布素材、角色、顺序、质量报告和公开地址。

正常成功的单图调用不会逐张写控制台日志，数据库是完整状态的事实来源。先确认容器实际配置，命令不会输出
Cloudflare API Token：

```powershell
docker compose --env-file .env -p geo-content-os -f infra/compose.yaml exec ai-worker sh -lc 'printenv IMAGE_AUTOMATION_ENABLED IMAGE_GENERATION_DRIVER IMAGE_PLANNER_MODEL_KEY CLOUDFLARE_IMAGE_MODEL CLOUDFLARE_IMAGE_QA_MODEL GENERATED_MEDIA_PUBLIC_BASE_URL'
```

预期至少为 `IMAGE_AUTOMATION_ENABLED=true`、`IMAGE_GENERATION_DRIVER=cloudflare`。若 Driver 是
`disabled`，系统只会生成模板图；若 Automation 是 `false`，质量通过后不会创建配图任务。

先用标题或平台查询最近的质量报告和配图运行：

```sql
SELECT
  version.content_json->>'title' AS title,
  variant.platform_code,
  report.created_at AS quality_created_at,
  report.decision,
  report.automation_gate_json->>'passed' AS gate_passed,
  media.id AS media_run_id,
  media.status AS media_status,
  media.provider,
  media.generation_model,
  media.inspection_model,
  media.diagnostics_json,
  media.last_error_json,
  media.started_at,
  media.finished_at
FROM quality_reports AS report
JOIN content_versions AS version
  ON version.id=report.content_version_id AND version.tenant_id=report.tenant_id
JOIN content_variants AS variant
  ON variant.id=report.variant_id AND variant.tenant_id=report.tenant_id
LEFT JOIN content_media_runs AS media
  ON media.quality_report_id=report.id AND media.tenant_id=report.tenant_id
WHERE report.created_at >= now() - interval '2 days'
  AND variant.platform_code IN ('official_site','baijiahao','sohu','lieju')
ORDER BY report.created_at DESC
LIMIT 100;
```

若已经有 `media_run_id`，继续查 Outbox 和实际素材：

```sql
SELECT
  media.id AS media_run_id,
  media.status AS media_status,
  event.status AS event_status,
  event.attempt_count,
  event.next_attempt_at,
  event.last_error,
  event.published_at
FROM content_media_runs AS media
LEFT JOIN outbox_events AS event
  ON event.aggregate_type='content_media_run'
  AND event.aggregate_id=media.id
  AND event.tenant_id=media.tenant_id
  AND event.event_type='content.variant.media_generation_requested.v1'
WHERE media.created_at >= now() - interval '2 days'
ORDER BY media.created_at DESC;

SELECT
  version.content_json->>'title' AS title,
  variant.platform_code,
  link.role,
  link.position,
  link.source,
  link.public_url,
  link.alt_text,
  link.quality_json,
  asset.object_uri,
  asset.mime_type,
  asset.size_bytes
FROM content_media_assets AS link
JOIN content_media_runs AS media
  ON media.id=link.content_media_run_id AND media.tenant_id=link.tenant_id
JOIN content_versions AS version
  ON version.id=link.content_version_id AND version.tenant_id=link.tenant_id
JOIN content_variants AS variant
  ON variant.id=media.variant_id AND variant.tenant_id=media.tenant_id
JOIN media_assets AS asset
  ON asset.id=link.media_asset_id AND asset.tenant_id=link.tenant_id
WHERE link.created_at >= now() - interval '2 days'
ORDER BY link.created_at DESC,link.role,link.position;
```

判读顺序：

1. 没有质量报告，或 `gate_passed` 不是 `true`：文章尚未获得配图资格；先排查生文或质量门禁。
2. `gate_passed=true` 但没有 `media_run_id`：该次质检时 `IMAGE_AUTOMATION_ENABLED` 未启用，或 AI Worker
   仍是旧镜像。旧质量报告不会自动补图。
3. 配图为 `queued`，Outbox 是 `pending/processing/failed`：检查 `outbox-relay` 及 `last_error`。
4. Outbox 已 `published` 但配图仍长期 `queued`：检查 AI Worker、Redis 和队列消费。
5. 配图长期为 `running`：检查 AI Worker 的规划、Cloudflare、视觉质检或对象存储错误。
6. 配图为 `fallback`：读取 `provider_failures`、`storage_failures` 和素材的 `source`；这表示已降级，
   不等于文章失败。
7. 配图为 `succeeded/fallback` 且官网不显示：先检查官网 `/capabilities` 是否返回
   `media_upload=true`，再检查 Publisher Worker 日志中的 `Official site media upload skipped` 和官网
   `public/upload/geo/` 写权限。采用随文上传时 `public_url` 为空是正常状态。
8. 发布尝试的 `response_json.media_upload` 记录官网媒体能力、成功素材 URL 和跳过数量；成功上传后图片
   由官网持久保存，Windows 离线不影响已发布图片。

容器日志按完整链路查看：

```powershell
docker compose --env-file .env -p geo-content-os -f infra/compose.yaml logs --since 24h outbox-relay ai-worker minio publisher-worker baijiahao-browser
```

对象存储上传失败时，AI Worker 会输出 `Content media asset storage failed`。日志包含
`mediaRunId`、`contentVersionId`、素材角色与位置，以及经过脱敏的底层 `cause`、网络错误码、HTTP 状态和
S3 Request ID；相同信息也会写入 `content_media_runs.diagnostics_json.storage_failures`：

```powershell
docker compose --env-file .env -p geo-content-os -f infra/compose.yaml logs --since 24h ai-worker | Select-String 'Content media asset storage failed'
```

旧内容、旧质量报告和已经排期的任务不会自动补图。只对部署后新通过质量门禁的自动化版本生效。

## 降级与回滚

- 临时停止外部生图：设置 `IMAGE_GENERATION_DRIVER=disabled`，系统改用模板图。
- 完全跳过配图阶段：设置 `IMAGE_AUTOMATION_ENABLED=false`，质量通过后直接走原有排期。
- Cloudflare 故障无需降低文章质量阈值，也无需人工伪造图像通过结论。
- 不删除 `content_media_runs`、`content_media_assets` 或 `media_assets` 历史记录。
