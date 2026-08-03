# ADR-0030：DeepSeek 配图规划与 Cloudflare Workers AI 自动配图

- 状态：已授权
- 日期：2026-08-03
- 任务：T148
- 适用范围：官网与百家号自动化文章

## 背景

现有自动化只生成文章正文。官网与百家号都缺少与精确内容版本关联、可审计并能自动发布的图片。
DeepSeek 当前只用于文本生成，不承担图片生成；本任务不引入 Gemini。

## 决策

1. 只有既有冻结质量门禁实际通过的版本才进入配图。配图不修改 `content_versions.content_json`，也不
   重新计算、替换或伪造质量报告。
2. DeepSeek `deepseek-v4-flash` 只生成两个正文场景的图片计划。服务端对计划执行确定性检查，禁止
   其他公司名称、品牌、Logo、电话、URL、二维码、价格、车牌和可识别真实案例。
3. 封面采用确定性模板；两个正文场景由 Cloudflare Workers AI
   `@cf/black-forest-labs/flux-1-schnell` 生成。
4. Cloudflare 视觉模型 `@cf/meta/llama-3.2-11b-vision-instruct` 对原始生成图执行机器门禁：相关性
   至少 80，且不得含文字、企业名称、Logo/水印、电话、不安全内容或伪装成真实证据的画面。通过后
   服务端再叠加“AI示意图”标识。
5. 模型规划、生成或视觉质检失败时，使用只含本公司名称“广州志远搬家服务有限公司”的确定性
   模板图。单张图片存储失败时跳过该图片；对象存储整体不可用时不带图继续排期。图片故障不得阻断
   已经通过质量门禁的文章。
6. 图片写入既有 S3 兼容对象存储，并以 `media_assets` 与内容版本关联。官网仅使用配置的持久公开
   CDN 地址，不把临时签名 URL 写入正文；百家号按素材 ID 在发布时从私有对象存储读取并上传。
7. 新增 `content_media_runs` 保存规划、供应商、模型、诊断和状态；新增 append-only
   `content_media_assets` 保存内容版本与合格素材的角色、顺序、替代文本、公开地址和图像质量报告。
8. Outbox 事件 `content.variant.media_generation_requested.v1` 投递到 `geo-ai`，至少一次消费，素材
   槽位和对象键均幂等。
9. DeepSeek 规划调用沿用模型费率卡写入用量账本。Cloudflare 外部调用次数写入本次配图诊断；在系统
   尚未接入 Cloudflare 的实际计价和结算数据前，不写入虚构的固定金额。

## 状态衔接

`quality_pending -> media_pending -> quality_pending -> 原有发布排期`

第二个 `quality_pending` 只用于恢复既有排期函数；传入的是同一份已落库质量报告和门禁结果，不产生
新的模型质量结论。

## 配置

- `IMAGE_AUTOMATION_ENABLED`
- `IMAGE_PLANNER_MODEL_KEY`
- `IMAGE_GENERATION_DRIVER=cloudflare|disabled`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_IMAGE_MODEL`
- `CLOUDFLARE_IMAGE_QA_MODEL`
- `IMAGE_GENERATION_STEPS`
- `IMAGE_PROVIDER_TIMEOUT_MS`
- `GENERATED_MEDIA_PUBLIC_BASE_URL`

Cloudflare 视觉模型首次使用前必须由账号所有者在 Cloudflare 控制台接受对应许可。系统不代替用户
接受第三方许可。

## 不采用的方案

- 不使用 Gemini 做质量兜底。
- 不让图像生成结果修改或降低文章质量门禁。
- 不把图片塞入不可变内容版本。
- 不用过期签名 URL 作为官网长期图片地址。
- 不把第三方企业名称、Logo 或真实报价数据绘制进图片。

## 验收

- 质量未通过时不创建配图任务；质量通过时只创建一个幂等任务。
- Cloudflare 合格图通过机器门禁并带“AI示意图”；不合格图自动换为模板图。
- Cloudflare、规划器或存储失败不会阻断合格文章原有排期。
- 官网输出持久图片地址，百家号输出同内容版本的封面与正文素材 ID。
- 配图运行、供应商、模型、提示哈希、图像质量和素材哈希可追溯。
- 不出现其他公司名称；不改变 ADR-0021/ADR-0028 冻结阈值。
- 迁移、Contracts、AI Worker、Publisher、平台渲染与 Compose 校验通过。
