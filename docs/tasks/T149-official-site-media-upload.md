# T149：官网媒体随文上传

- 状态：已授权
- 依赖：T148、ADR-0030、ADR-0031
- 范围：官网 Delivery Adapter、Publisher Worker、志远官网发布 API、部署文档与测试

## 交付物

1. 官网 `/capabilities` 声明 `media_upload`，新增同 Bearer Token 鉴权的 `POST /media`。
2. 官网按图片 SHA-256 幂等保存 JPEG，返回官网 HTTPS 地址，并只允许正文引用自身上传目录。
3. Publisher 从私有 MinIO 读取并复核素材，上传后使用返回地址渲染和发布官网文章。
4. 上传失败无图降级；发布尝试响应记录上传结果；百家号链路不变。
5. Windows 配置明确保持 MinIO 私有且 `GENERATED_MEDIA_PUBLIC_BASE_URL` 为空。

## 验收命令

```bash
pnpm --filter @geo-content-os/adapter-platforms test
pnpm --filter @geo-content-os/worker-publisher test
pnpm --filter @geo-content-os/worker-publisher typecheck
pnpm lint

# 志远官网仓库
php tests/GeoNewsPublisherTest.php
php tests/GeoPublishHttpTest.php
php -l app/service/GeoNewsPublisher.php
php -l app/controller/GeoPublishApi.php
```
