# T155：企业证照资料导入与受控随文展示

- 状态：已完成
- 决策：ADR-0053
- 依赖：ADR-0014、T148、T149

## 交付物

1. “导入资料”支持 PNG、JPEG、WebP 证照图片及人工核验字段、有效期和公开展示授权。
2. API 与数据库保存精确证照元数据，校验图片签名、可解码性、尺寸、大小和 HTTPS 核验链接。
3. Knowledge Worker 使用人工确认字段建立可检索文本与引用，不依赖生产 OCR。
4. 内容配图只选择当前内容实际引用、当前企业匹配且明确授权的证照，并生成移除文件元数据的发布副本。
5. 官网、百家号和搜狐号接入证照副本；列举网首版排除；失败保持无图降级。
6. 资料列表、详情页、契约、OpenAPI、迁移、测试与部署说明同步更新。

## 文件范围

- `apps/web/src/features/know-01/`、`know-02/`、`know-03/`
- `apps/api/src/modules/knowledge/`、`apps/api/src/database/`
- `workers/knowledge/`、`workers/ai/`、`workers/publisher/`
- `packages/contracts/`、`packages/adapters/image/`、`packages/adapters/platforms/official_site/`
- `PROJECT_CONTEXT.md`、`docs/adr/`

## 验收命令

```bash
pnpm --filter @geo-content-os/contracts test
pnpm --filter @geo-content-os/api test:integration -- source-upload.integration.test.ts
pnpm --filter @geo-content-os/worker-knowledge test
pnpm --filter @geo-content-os/worker-ai test
pnpm --filter @geo-content-os/worker-publisher test
pnpm --filter @geo-content-os/adapter-image test
pnpm --filter @geo-content-os/adapter-platforms test
pnpm --filter @geo-content-os/web build
pnpm verify:openapi
pnpm lint
```

## 部署

先部署向后兼容的 Web，再执行数据库迁移 `0050_certificate_source_materials`，随后依次部署 API、
Knowledge Worker、AI Worker、Publisher 及百家号/搜狐号浏览器 Worker。Web 与 API 的部署间隔内不要上传
证照；普通文档上传和旧资料详情保持兼容。无需操作生产官网代码；旧资料、旧质量报告和旧发布任务不会
自动重新处理。
