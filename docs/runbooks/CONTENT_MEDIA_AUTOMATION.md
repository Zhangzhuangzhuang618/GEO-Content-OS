# 自动配图运行手册

## 启用前检查

1. Cloudflare 账号已开通 Workers AI，并由账号所有者接受
   `@cf/meta/llama-3.2-11b-vision-instruct` 的使用许可。
2. AI Worker 可访问 Cloudflare API 和对象存储。
3. `GENERATED_MEDIA_PUBLIC_BASE_URL` 指向对象键的持久 HTTPS/CDN 前缀。未配置时官网不展示图片，
   百家号仍可从私有对象存储上传图片。
4. 不配置 Gemini；本链路没有 Gemini 环境变量或调用。

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
GENERATED_MEDIA_PUBLIC_BASE_URL=https://cdn.example.com
```

## 状态与诊断

- `content_media_runs.status=queued|running`：等待或正在处理。
- `succeeded`：两个正文场景均由 Cloudflare 生成并通过视觉门禁。
- `fallback`：至少一张使用模板，或有素材存储失败；文章仍按原流程排期。
- `diagnostics_json.provider_failures`：生成/视觉质检失败的脱敏原因。
- `diagnostics_json.storage_failures`：对象存储失败的脱敏原因。
- `content_media_assets`：实际可发布素材、角色、顺序、质量报告和公开地址。

旧内容、旧质量报告和已经排期的任务不会自动补图。只对部署后新通过质量门禁的自动化版本生效。

## 降级与回滚

- 临时停止外部生图：设置 `IMAGE_GENERATION_DRIVER=disabled`，系统改用模板图。
- 完全跳过配图阶段：设置 `IMAGE_AUTOMATION_ENABLED=false`，质量通过后直接走原有排期。
- Cloudflare 故障无需降低文章质量阈值，也无需人工伪造图像通过结论。
- 不删除 `content_media_runs`、`content_media_assets` 或 `media_assets` 历史记录。
