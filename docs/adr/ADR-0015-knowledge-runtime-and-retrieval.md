# ADR-0015：知识库运行时与生成检索接线

## 状态

Accepted — 2026-07-19

## 背景

知识库原有上传、资料列表、分块、Embedding、检索和引用契约，但 Compose 中的 Knowledge
Worker 仍是通用健康进程，内容生成也没有读取 `brief_sources`。因此资料可以被登记，却不会稳定地
完成解析、向量化或进入 Content Writer 输入。

## 决策

- `knowledge-worker` 使用独立 Docker 镜像和 BullMQ 消费入口，处理安全扫描、URL 抓取或对象存储读取、解析、分块与向量化。
- 默认使用本地确定性 n-gram Embedding 与 Rerank 实现，不依赖额外外部 API；向量维度保持 1536。
- 内容生成只在当前租户、工作区、项目范围内检索 `brief_sources.source_document_id` 指定的有效资料。
- 检索顺序为查询向量化、混合检索、重排；选中片段作为 Content Writer citations 输入。
- 生成结果引用写入 `ai_citations`，资料详情的引用次数按实际文章引用统计。
- URL 抓取允许无凭证的 HTTP(S)，仍由 Safe Web Fetch 执行 DNS 固定、私网阻断、重定向和大小限制。
- 当前没有生产 OCR Provider，因此用户界面只开放 PDF、DOCX、TXT；不得宣称图片上传可用。

## 后果

- 上传资料会实质影响后续内容生成，并可从文章引用回溯到资料片段。
- 本地 Embedding/Rerank 适合 MVP 与单机部署，不等同于高质量语义模型；后续如切换外部 Provider，必须保持相同租户隔离、批次和成本记账边界。
- 自动事实抽取、Fact Checker 和 GEO Optimizer 不在本 ADR 范围内，其运行时缺口记录在运行能力审计中。
