# T156：企业保险证明原件私有保存与脱敏摘要

## 目标

允许企业上传含个人信息的保险证明 PDF，私有保存原件，只让人工确认的非敏感摘要进入检索和生文。

## 范围

1. `SourceCreate` 增加 `insurance_proof` 及投保主体、承保机构、保险类型、参保人数和摘要确认字段。
2. 保险证明必须使用 PDF、完整保障期间和 `verified` 可信级别。
3. 数据库使用 `source-insurance-proof@1` 严格约束字段集合和范围。
4. Knowledge Worker 跳过 PDF Parser 与 OCR，确定性生成脱敏摘要。
5. 资料标题固定为“企业保险证明”，不得让文件名、用户自填标题或保单编号进入检索。
6. 资料详情展示保险摘要并明确原件禁止公开。
7. 原件继续保存在私有对象存储，不接入文章媒体链路。

## 不在范围

- 不识别或展示人员名单、保单号、个人证件号、电话、邮箱和银行卡。
- 不增加 OCR Provider，不从扫描像素自动推断保险事实。
- 不自动转换历史普通 PDF 或历史失败资料。

## 验收命令

```bash
pnpm --filter @geo-content-os/contracts test
pnpm --filter @geo-content-os/worker-knowledge test
pnpm --filter @geo-content-os/api test:integration -- source-upload.integration.test.ts
pnpm --filter @geo-content-os/web typecheck
pnpm generate:openapi
pnpm verify:openapi
pnpm db:verify:fresh
```

另用用户提供的九页扫描 PDF 运行 Knowledge Worker 解析入口，确认输出只包含脱敏摘要且不包含原件
文字或个人信息。该原件不得复制进仓库或测试快照。

## 部署与兼容

先部署向后兼容的 Web，再执行迁移 `0051_insurance_proof_source_materials`，随后部署 API 和 Knowledge
Worker。旧资料、旧索引、旧质量报告和旧发布任务不自动变化；无需操作生产官网。
