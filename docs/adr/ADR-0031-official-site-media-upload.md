# ADR-0031：官网媒体随文上传

- 状态：已授权
- 日期：2026-08-04
- 任务：T149
- 适用范围：官网 API 自动发布图片

## 背景

ADR-0030 生成的图片保存在运行 GEO Content OS 的 Windows 私有 MinIO。该服务器没有固定公网 IP，
不应为了官网图片长期可用而暴露 MinIO 或建立热链。百家号已经在发布时读取本地图片并上传，但官网
旧实现只会把预配置公开 URL 写入文章 HTML。

## 决策

1. Windows MinIO 继续作为私有暂存和可追溯对象存储，不要求公网域名。
2. 官网能力响应增加 `media_upload`。能力存在时，Publisher 在文章发布前从对象存储读取图片，校验
   对象 URI、MIME、大小和 SHA-256，再调用官网 `POST /media` 上传 JPEG 二进制。
3. 媒体请求复用官网平台账号的 Bearer Token；使用素材 UUID 生成幂等键，并携带内容版本、素材、角色
   和内容哈希头。官网重新校验哈希、MIME 与图片结构。
4. 官网按 SHA-256 内容寻址保存到自身公开目录，返回持久 HTTPS URL。Publisher 使用返回 URL 渲染
   `body_html` 后再调用既有 `/publish`；官网只保留属于自身 `/upload/geo/` 的图片。
5. 单图读取或上传失败时跳过该图，继续发布文章，并在 Publisher 日志和发布尝试响应中记录脱敏诊断。
   不降低文章或图像门禁，不伪造上传成功状态。
6. 百家号浏览器上传路径不变。`GENERATED_MEDIA_PUBLIC_BASE_URL` 保留为旧 CDN 回退；本方案下留空。

## 兼容性

- 旧官网未返回 `media_upload` 时按 `false` 处理；已有持久 `public_url` 仍可作为回退。
- 不新增 GEO Content OS 数据库表、公开 API 或迁移。
- 官网媒体端点采用内容寻址，重复上传不会创建重复文件；文章发布仍使用原冻结幂等键。

## 验收

- Windows MinIO 无公网入口且 `GENERATED_MEDIA_PUBLIC_BASE_URL` 为空时，官网文章仍能显示已上传图片。
- Publisher 在上传前复核素材大小和 SHA-256；损坏素材不得上传。
- 官网拒绝非 JPEG、哈希不匹配、超过 10 MB、第三方图片 URL 和不安全 HTML。
- 上传重放复用同一个官网文件；正文第一张合格图片同时成为官网列表封面。
- 媒体失败不阻断合格文章，发布尝试保留成功 URL 与跳过数量。
- 官方站点 Adapter、Publisher、官网服务层和真实 HTTP 路由测试通过。
