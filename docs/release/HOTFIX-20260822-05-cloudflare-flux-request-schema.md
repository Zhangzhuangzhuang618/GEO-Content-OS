# HOTFIX-20260822-05 Cloudflare FLUX 请求契约修复

## 生产证据

- 最近两天的官网和百家号配图运行均为 `fallback`。
- 图片规划、素材存储均正常，每个正文场景都在 Cloudflare 生成阶段返回 HTTP 400。
- 使用生产容器中的同一账号、Token 和模型执行脱敏探针时，Cloudflare 返回错误码 `5006`，说明
  `@cf/black-forest-labs/flux-1-schnell` 当前输入契约不接受 `seed` 字段。
- 移除 `seed` 后，同模型生成和既有视觉质检请求均返回 HTTP 200。

## 修复

- FLUX 生成请求只发送当前模型接受的 `prompt` 与 `steps`。
- 增加请求契约测试，禁止再次向当前 Cloudflare 生成端点发送 `seed`。

## 不变项

- 不降低图片视觉门禁、文章冻结质量门槛或品牌与事实规则。
- 不改变模板降级、对象存储、素材哈希和 AI 图片披露逻辑。
- 不自动重跑历史 `fallback` 配图运行；部署后新建的配图任务使用修复后的请求契约。
- 无数据库迁移、公开 API 或 Web 变更。
