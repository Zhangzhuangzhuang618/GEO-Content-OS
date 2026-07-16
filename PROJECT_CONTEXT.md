# GEO Content OS - 项目上下文

> 企业级 GEO 多平台内容生产系统（MVP v1.0）
> 文档基线日期：2026-07-15
> 上下文版本：v2.1（全面开发冻结修订版）

## 0. 开发冻结声明

本文件用于快速建立开发上下文。可执行事实源优先级：`packages/contracts/`（枚举、状态、权限、错误、事件、API/Skill Schema）> `apps/api/src/database/migrations/`（数据库）> 代码生成 OpenAPI 3.1（接口）。五份 DOCX 用于解释、任务和验收。发生冲突必须停止局部实现，先修事实源并同步文档。

## 1. 产品范围

GEO Content OS 是 SaaS 多租户内容生产系统，闭环为策略/知识 -> 主题/Brief -> 母稿和七平台变体 -> 事实/GEO/质量 -> 冻结审核 -> API 发布或确定性导出 -> 指标与成本。每个发布版本必须追溯 source chunk、content version、Prompt、model、rules、review 和 publish attempt。

### MVP 平台

| code | 平台 | 形态 | 交付 |
|---|---|---|---|
| official_site | 官网 | SEO 长文/专题页 | API 或 HTML/Markdown 导出 |
| baijiahao | 百家号 | 图文/动态 | 能力探测后 API；否则导出 |
| toutiao | 头条号 | 图文/微头条 | 能力探测后 API；否则导出 |
| zhihu | 知乎 | 回答/文章 | 能力探测后 API；否则导出 |
| xiaohongshu | 小红书 | 笔记/图文 | MVP 默认导出；授权 API 可插拔 |
| wechat_mp | 微信公众号 | 群发图文/长文 | 官方 API 或导出 |
| douyin | 抖音 | 口播脚本/分镜/字幕 | MVP 导出脚本包；发布能力可插拔 |

## 2. 冻结技术栈

| 领域 | 技术 | 约束 |
|---|---|---|
| Runtime | Node.js 22 LTS；pnpm 10；TypeScript 5.8 | 根目录 engines/packageManager 锁定；CI 与 Docker 使用同一版本 |
| Web | Next.js 15 App Router；React 19；Tailwind CSS 4；TanStack Query 5 | React Hook Form + Zod；服务端组件默认，交互页面按需 client |
| API | NestJS 11 + FastifyAdapter | REST /api/v1；Zod 运行时 DTO；OpenAPI 3.1 从代码生成 |
| Database | PostgreSQL 16；Drizzle ORM + drizzle-kit | pgcrypto、vector、citext；复杂 FTS/vector/RLS 使用迁移 SQL |
| Queue/Cache | Redis 7.4；BullMQ 5 | Outbox 至少一次投递；Redis 不承载不可恢复事实 |
| Object storage | S3 compatible；local MinIO | 原文件、媒体、导出包、证据截图；服务端签名 URL |
| AI | Model/Embedding/Rerank/OCR Adapter | 真实 provider/model ID、费率、超时和能力通过配置注入 |
| Observability | OpenTelemetry；Prometheus；Grafana；Loki | request_id、tenant_id、job_id、run_id 全链路关联 |
| Testing | Vitest；Supertest；Playwright；Testcontainers | 单元、集成、契约、E2E、迁移和隔离测试 |

### 仓库边界

```text
apps/web
apps/api/src/modules/{identity,workspace,knowledge,content,quality,review,publishing,analytics,billing,audit}
packages/{contracts,skills,adapters,security,observability,testkit,sdk}
workers/{knowledge,ai,outbox-relay,publisher,analytics,lifecycle}
infra/{docker,observability,backup}
docs/
```

## 3. 身份、权限与租户

- 邮箱密码 Argon2id；数据库 Session；HttpOnly Secure SameSite=Lax Cookie；写请求双提交 CSRF。
- `sessions.active_tenant_id` 选择租户，但每次请求重新检查 active membership。
- 资源不存在或越界统一 `RESOURCE_NOT_FOUND`(404)；范围内但动作无权为 `PERMISSION_DENIED`(403)。
- platform_admin 读取租户内容必须使用最长 8 小时 `support_access_grant`，所有访问写审计。
- Repository/队列/导出均接受服务端 TenantContext；客户端 tenant_id 不进入写模型。

### 平台角色

| code | 名称 | 边界 |
|---|---|---|
| platform_admin | 平台管理员 | 平台租户、全局模型/费率、系统审计；租户数据访问必须创建限时 support_access_grant |
| platform_operator | 平台运营 | 平台规则、Prompt 发布、运行监控；默认无租户内容读取权 |

### 租户角色

| code | 名称 | 边界 |
|---|---|---|
| tenant_owner | 租户所有者 | 账单、成员、工作区和全部租户资源 |
| tenant_admin | 租户管理员 | 成员、工作区、平台账号、策略和全部内容 |
| strategy_editor | 策略编辑 | 品牌、关键词、主题、资料和 Brief |
| content_editor | 内容编辑 | 内容包、生成、编辑、质量检查和提交审核 |
| reviewer | 审核人 | 审核列表、证据、通过、退回和加签 |
| publisher | 发布人 | 平台账号、排期、发布、重试和导出 |
| analyst | 分析师 | 指标、可见性、成本和导出 |
| viewer | 只读成员 | 授权工作区内只读 |

## 4. 核心状态与不变量

### ContentPackage

`draft | generating | generated | all_failed | editing | in_review | rejected | approved | scheduled | publishing | publish_failed | published | cancelled | archived`

Package 状态仅是 `PackageStatusProjector` 的摘要。优先级：archived/cancelled > publishing > in_review > generating > publish_failed > scheduled > published > rejected > approved > editing > generated > all_failed > draft。

### ContentVariant

`draft | generating | generation_failed | generated | quality_failed | quality_passed | in_review | review_approved | review_rejected | approved | scheduled | publishing | published | publish_failed | cancelled`

审核、排期、发布授权只读取 Variant 状态。取消运行恢复前一稳定状态；只有 abandon package/drop variant 进入 cancelled。编辑 approved 内容产生新 content_version 并使旧审批失效。

## 5. 数据模型

冻结表数：57。所有业务主键/API ID 为 UUID；content_versions.content_json 是内容唯一权威；append-only 表由数据库 trigger 保护。

| 表 | 用途 |
|---|---|
| `users` | 平台级登录身份 |
| `platform_roles` | 平台角色授权 |
| `tenants` | SaaS 隔离和计费根 |
| `support_access_grants` | 平台管理员限时访问租户数据的授权 |
| `memberships` | 用户在租户内的角色 |
| `sessions` | 数据库权威登录会话 |
| `password_reset_tokens` | 一次性密码重置令牌 |
| `invitations` | 租户邀请 |
| `subscriptions` | 套餐周期和配额 |
| `workspaces` | 协作、检索和策略作用域 |
| `workspace_memberships` | 用户在工作区的资源范围 |
| `projects` | 品牌/业务主题边界 |
| `brand_profiles` | 不可覆盖的品牌策略版本 |
| `keyword_sets` | 项目关键词集合 |
| `keywords` | 关键词、意图和平台范围 |
| `topic_candidates` | Topic Planner 可采纳主题 |
| `source_documents` | 原始可信资料 |
| `ingest_jobs` | 解析/OCR/分块/索引任务 |
| `source_chunks` | RAG 最小引用单元 |
| `embeddings` | 分块向量 |
| `facts` | 结构化候选/已验证事实 |
| `fact_sources` | 事实的原始来源证据 |
| `briefs` | 内容生产输入 |
| `brief_sources` | Brief 选择的证据资料 |
| `brief_keywords` | Brief 选择的关键词 |
| `content_packages` | 生产聚合根和状态摘要 |
| `content_versions` | 母稿或平台变体的不可变内容版本；内容 JSON 唯一权威 |
| `content_variants` | 平台发布最小单元；不重复保存 content_json |
| `content_blocks` | 版本内结构化段落 |
| `content_block_locks` | 当前变体的段落锁 |
| `generation_runs` | Skill/模型运行记录 |
| `ai_citations` | 内容 claim 到 chunk 的精确映射 |
| `fact_check_results` | 每次运行的 claim 判定 |
| `fact_evidences` | Fact Checker 实际证据；unsupported 不写行 |
| `quality_reports` | 不可变质量检查报告 |
| `prompt_versions` | 不可覆盖 Prompt 版本 |
| `platform_rule_versions` | 七平台硬约束版本 |
| `model_rate_cards` | 模型能力和费率版本 |
| `review_snapshots` | 不可变审核快照头 |
| `review_snapshot_variants` | 审核范围和精确内容版本 |
| `review_snapshot_citations` | 审核时冻结的引用集合 |
| `review_requirements` | 加签和必需审核人 |
| `review_actions` | 审核动作时间线 |
| `platform_accounts` | 平台账号和能力 |
| `media_assets` | 图片、视频和证据截图元数据 |
| `publish_jobs` | 排期和发布状态 |
| `publish_attempts` | 不可变发布尝试 |
| `export_artifacts` | 无 API 时的可下载导出包 |
| `import_jobs` | 指标导入批次 |
| `metric_records` | 平台指标事实 |
| `visibility_observations` | 问答/搜索可见性观察 |
| `analytics_export_jobs` | 分析数据异步导出任务 |
| `usage_ledger` | 全成本 append-only 用量账本 |
| `idempotency_records` | HTTP 写请求幂等结果 |
| `outbox_events` | 事务事件箱和投递租约 |
| `audit_events` | 不可变审计事件 |
| `tenant_export_jobs` | 租户数据导出和删除前归档 |

### 审核冻结

review_snapshot 固定 brand_profile、prompt_version、model_key、platform_rules_hash、quality_rules_hash；review_snapshot_variants 固定 variant/content_version/content_hash/platform_rule/quality_report；review_snapshot_citations 固定引用。决策前重算 snapshot_hash。

### Fact Checker

`fact_check_results` 记录每次 claim 判定；`fact_evidences` 仅记录真实证据。unsupported 必须 `evidences=[]`。claim_hash 由服务端规范化后计算，唯一键 `(tenant_id,generation_run_id,variant_id,claim_hash)`。

### 全成本

usage_ledger 归属 tenant/workspace/project/package/variant/generation_run，类别为 llm/embedding/rerank/ocr/storage/queue/platform_api/manual_adjustment；只追加、冲正新行。

## 6. AI、Skills 与 RAG

核心 Skills：`material-parser`, `content-writer`, `fact-checker`, `topic-planner`, `geo-optimizer`, `quality-checker`。每个 Skill 使用 Draft 2020-12 JSON Schema、版本化 Prompt/Few-shot、Tool 白名单和统一 SkillResult Envelope。

RAG：ingest -> normalize -> chunk(500..900,overlap=80) -> PostgreSQL FTS(ts_rank_cd)+pgvector -> fuse -> rerank -> diversify -> cite。MVP 不称 BM25。强制 tenant/workspace/project/trust/effective/status 过滤。

真实 provider_model_id、能力和费率由配置/model_rate_cards 提供；文档中的 flash/pro 是逻辑 model_key。

## 7. API 约定

Base `/api/v1`；JSON；UTC；cents；cursor 分页；Zod DTO；OpenAPI 代码生成；写操作 CSRF+Idempotency-Key；所有可变资源返回 version。

冻结基线原为 114 个端点；ADR-0002 为 REV-01 领取闭环新增 1 个端点，ADR-0003 为 ANL-02 批次回滚新增 1 个端点，ADR-0004 为 ANL-03 批量导入和趋势查询新增 2 个端点，ADR-0005 为 ANL-04 预算查看和供应商账单对账新增 2 个端点，ADR-0006 为 SET-01 邀请记录补充 1 个只读端点，当前可执行端点数为 121。

| 组 | 方法 | 路径 | 权限 | 请求 | 返回 | 幂等 |
|---|---|---|---|---|---|---|
| 身份 | POST | `/auth/login` | public | LoginRequest | SessionView | - |
| 身份 | POST | `/auth/logout` | authenticated | CsrfRequest | 204 | session |
| 身份 | GET | `/auth/session` | authenticated | - | SessionView | - |
| 身份 | GET | `/auth/tenants` | authenticated | - | TenantChoice[] | - |
| 身份 | POST | `/auth/switch-tenant` | authenticated | SwitchTenantRequest | SessionView | key+body_hash |
| 身份 | POST | `/auth/password/forgot` | public | ForgotPasswordRequest | 202 | - |
| 身份 | POST | `/auth/password/reset` | public | ResetPasswordRequest | 204 | token |
| 身份 | POST | `/auth/password/change` | authenticated | ChangePasswordRequest | 204 | key+body_hash |
| 身份 | GET | `/invitations` | tenant_admin_or_owner | InvitationListQuery | InvitationPage | - |
| 身份 | POST | `/invitations` | tenant_admin_or_owner | CreateInvitationRequest | InvitationView | key+body_hash |
| 身份 | POST | `/invitations/{token}/accept` | public | AcceptInvitationRequest | SessionView | token |
| 身份 | DELETE | `/invitations/{id}` | tenant_admin_or_owner | - | 204 | resource+version |
| 平台 | POST | `/platform/tenants` | platform_admin | CreateTenantRequest | TenantView | key+body_hash |
| 平台 | GET | `/platform/tenants` | platform_admin | TenantListQuery | TenantPage | - |
| 平台 | POST | `/platform/tenants/{id}/suspend` | platform_admin | ReasonRequest | TenantView | resource+version |
| 平台 | POST | `/platform/tenants/{id}/restore` | platform_admin | - | TenantView | resource+version |
| 平台 | POST | `/platform/support-access-grants` | platform_admin | SupportGrantRequest | SupportGrantView | key+body_hash |
| 平台 | GET | `/platform/prompt-versions` | platform_operator | PromptVersionQuery | PromptVersionPage | - |
| 平台 | POST | `/platform/prompt-versions` | platform_operator | CreatePromptVersionRequest | PromptVersionView | key+body_hash |
| 平台 | POST | `/platform/prompt-versions/{id}/publish` | platform_operator | PublishVersionRequest | PromptVersionView | resource+version |
| 平台 | POST | `/platform/prompt-versions/{id}/retire` | platform_operator | ReasonRequest | PromptVersionView | resource+version |
| 平台 | GET | `/platform/rule-versions` | platform_operator | RuleVersionQuery | RuleVersionPage | - |
| 平台 | POST | `/platform/rule-versions` | platform_operator | CreateRuleVersionRequest | RuleVersionView | key+body_hash |
| 平台 | POST | `/platform/rule-versions/{id}/publish` | platform_operator | PublishVersionRequest | RuleVersionView | resource+version |
| 平台 | POST | `/platform/rule-versions/{id}/retire` | platform_operator | ReasonRequest | RuleVersionView | resource+version |
| 租户 | GET | `/tenant` | tenant_member | - | TenantView | - |
| 租户 | PATCH | `/tenant` | tenant_owner | UpdateTenantRequest | TenantView | key+version |
| 租户 | GET | `/memberships` | tenant_admin_or_owner | MemberListQuery | MembershipPage | - |
| 租户 | PATCH | `/memberships/{id}` | tenant_admin_or_owner | UpdateMembershipRequest | MembershipView | key+version |
| 租户 | POST | `/memberships/{id}/disable` | tenant_admin_or_owner | ReasonRequest | MembershipView | resource+version |
| 租户 | POST | `/memberships/{id}/restore` | tenant_admin_or_owner | - | MembershipView | resource+version |
| 工作区 | POST | `/workspaces` | tenant_admin_or_owner | CreateWorkspaceRequest | WorkspaceView | key+body_hash |
| 工作区 | GET | `/workspaces` | tenant_member | WorkspaceListQuery | WorkspacePage | - |
| 工作区 | GET | `/workspaces/{id}` | tenant_member | - | WorkspaceView | - |
| 工作区 | PATCH | `/workspaces/{id}` | tenant_admin_or_owner | UpdateWorkspaceRequest | WorkspaceView | key+version |
| 工作区 | POST | `/workspaces/{id}/archive` | tenant_admin_or_owner | ReasonRequest | WorkspaceView | resource+version |
| 工作区 | POST | `/projects` | strategy_editor_or_admin | CreateProjectRequest | ProjectView | key+body_hash |
| 工作区 | GET | `/projects` | tenant_member | ProjectListQuery | ProjectPage | - |
| 工作区 | GET | `/projects/{id}` | tenant_member | - | ProjectView | - |
| 工作区 | PATCH | `/projects/{id}` | strategy_editor_or_admin | UpdateProjectRequest | ProjectView | key+version |
| 策略 | POST | `/brand-profiles` | strategy_editor_or_admin | CreateBrandProfileRequest | BrandProfileView | key+body_hash |
| 策略 | GET | `/brand-profiles` | tenant_member | BrandProfileQuery | BrandProfilePage | - |
| 策略 | GET | `/brand-profiles/{id}` | tenant_member | - | BrandProfileView | - |
| 策略 | POST | `/brand-profiles/{id}/publish` | strategy_editor_or_admin | PublishVersionRequest | BrandProfileView | resource+version |
| 策略 | POST | `/brand-profiles/{id}/retire` | strategy_editor_or_admin | ReasonRequest | BrandProfileView | resource+version |
| 策略 | POST | `/keyword-sets` | strategy_editor_or_admin | CreateKeywordSetRequest | KeywordSetView | key+body_hash |
| 策略 | GET | `/keyword-sets` | tenant_member | KeywordSetQuery | KeywordSetPage | - |
| 策略 | GET | `/keyword-sets/{id}` | tenant_member | - | KeywordSetDetail | - |
| 策略 | POST | `/keyword-sets/{id}/keywords` | strategy_editor_or_admin | UpsertKeywordsRequest | Keyword[] | key+body_hash |
| 策略 | POST | `/topic-plans/generate` | strategy_editor_or_admin | TopicPlanRequest | GenerationRunView | key+body_hash |
| 策略 | GET | `/topic-candidates` | tenant_member | TopicCandidateQuery | TopicCandidatePage | - |
| 策略 | POST | `/topic-candidates/{id}/adopt` | strategy_editor_or_admin | AdoptTopicRequest | BriefView | resource+version |
| 知识 | POST | `/sources` | strategy_or_content_editor_or_admin | multipart SourceCreate | SourceView+IngestJob | key+content_hash |
| 知识 | GET | `/sources` | tenant_member | SourceListQuery | SourcePage | - |
| 知识 | GET | `/sources/{id}` | tenant_member | - | SourceDetailView | - |
| 知识 | POST | `/sources/{id}/reindex` | strategy_or_content_editor_or_admin | ReindexRequest | IngestJobView | resource+source_hash |
| 知识 | DELETE | `/sources/{id}` | strategy_or_content_editor_or_admin | ReasonRequest | 204 | resource+version |
| 知识 | GET | `/ingest-jobs/{id}` | tenant_member | - | IngestJobView | - |
| 知识 | GET | `/facts` | tenant_member | FactQuery | FactPage | - |
| 知识 | POST | `/facts/{id}/verify` | reviewer_or_admin | VerifyFactRequest | FactView | resource+version |
| 内容 | POST | `/briefs` | strategy_or_content_editor_or_admin | CreateBriefRequest | BriefView | key+body_hash |
| 内容 | GET | `/briefs` | tenant_member | BriefListQuery | BriefPage | - |
| 内容 | GET | `/briefs/{id}` | tenant_member | - | BriefView | - |
| 内容 | PATCH | `/briefs/{id}` | strategy_or_content_editor_or_admin | UpdateBriefRequest | BriefView | key+version |
| 内容 | POST | `/content-packages` | content_editor_or_admin | CreateContentPackageRequest | ContentPackageView | key+body_hash |
| 内容 | GET | `/content-packages` | tenant_member | ContentPackageQuery | ContentPackagePage | - |
| 内容 | GET | `/content-packages/{id}` | tenant_member | - | ContentPackageDetail | - |
| 内容 | POST | `/content-packages/{id}/generate` | content_editor_or_admin | GenerateContentRequest | GenerationRunView | key+body_hash |
| 内容 | POST | `/content-packages/{id}/abandon` | content_editor_or_admin | ReasonRequest | ContentPackageView | resource+version |
| 内容 | POST | `/content-packages/{id}/archive` | tenant_admin_or_owner | ReasonRequest | ContentPackageView | resource+version |
| 内容 | POST | `/content-packages/{id}/reopen` | reviewer_or_admin | ReopenVariantsRequest | ContentPackageDetail | key+version |
| 内容 | GET | `/generation-runs/{id}` | content_editor_or_admin | - | GenerationRunView | - |
| 内容 | POST | `/generation-runs/{id}/cancel` | content_editor_or_admin | ReasonRequest | GenerationRunView | resource+version |
| 内容 | GET | `/content-versions/{id}` | tenant_member | - | ContentVersionView | - |
| 内容 | GET | `/content-versions/{id}/diff` | tenant_member | CompareVersionQuery | ContentDiffView | - |
| 内容 | POST | `/content-versions/{id}/rollback` | content_editor_or_admin | RollbackRequest | ContentVersionView | key+version |
| 内容 | GET | `/content-variants/{id}` | tenant_member | - | ContentVariantDetail | - |
| 内容 | PATCH | `/content-variants/{id}` | content_editor_or_admin | UpdateVariantRequest | ContentVariantDetail | key+version |
| 内容 | POST | `/content-variants/{id}/blocks/{blockId}/lock` | content_editor_or_admin | LockBlockRequest | BlockLockView | resource+version |
| 内容 | DELETE | `/content-variants/{id}/blocks/{blockId}/lock` | content_editor_or_admin | - | 204 | resource+version |
| 内容 | POST | `/content-variants/{id}/quality-check` | content_editor_or_admin | QualityCheckRequest | GenerationRunView | key+content_hash |
| 内容 | POST | `/content-variants/{id}/regenerate` | content_editor_or_admin | RegenerateVariantRequest | GenerationRunView | key+body_hash |
| 内容 | POST | `/content-variants/{id}/drop` | content_editor_or_admin | DropVariantRequest | ContentVariantDetail | resource+version |
| 审核 | POST | `/content-packages/{id}/submit-review` | content_editor_or_admin | SubmitReviewRequest | ReviewSnapshotView | key+snapshot_hash |
| 审核 | GET | `/review-snapshots` | reviewer_or_admin | ReviewInboxQuery | ReviewSnapshotPage | - |
| 审核 | GET | `/review-snapshots/{id}` | reviewer_or_admin | - | ReviewSnapshotDetail | - |
| 审核 | POST | `/review-snapshots/{id}/claim` | reviewer_or_admin | ClaimReviewRequest | ReviewClaimView | key+version |
| 审核 | POST | `/review-snapshots/{id}/approve` | reviewer_or_admin | ReviewDecisionRequest | ReviewSnapshotDetail | key+version |
| 审核 | POST | `/review-snapshots/{id}/reject` | reviewer_or_admin | ReviewDecisionRequest | ReviewSnapshotDetail | key+version |
| 审核 | POST | `/review-snapshots/{id}/request-signoff` | reviewer_or_admin | RequestSignoffRequest | ReviewRequirementView | key+version |
| 审核 | GET | `/review-snapshots/{id}/actions` | tenant_member | - | ReviewAction[] | - |
| 发布 | POST | `/platform-accounts` | publisher_or_admin | CreatePlatformAccountRequest | PlatformAccountView | key+body_hash |
| 发布 | GET | `/platform-accounts` | publisher_or_admin | PlatformAccountQuery | PlatformAccountPage | - |
| 发布 | POST | `/platform-accounts/{id}/refresh` | publisher_or_admin | RefreshAccountRequest | PlatformAccountView | resource+version |
| 发布 | POST | `/platform-accounts/{id}/test` | publisher_or_admin | - | CapabilityView | resource+version |
| 发布 | POST | `/platform-accounts/{id}/disable` | publisher_or_admin | ReasonRequest | PlatformAccountView | resource+version |
| 发布 | POST | `/publish-jobs` | publisher_or_admin | CreatePublishJobRequest | PublishJobView | key+body_hash |
| 发布 | GET | `/publish-jobs` | publisher_or_admin | PublishJobQuery | PublishJobPage | - |
| 发布 | GET | `/publish-jobs/{id}` | publisher_or_admin | - | PublishJobDetail | - |
| 发布 | POST | `/publish-jobs/{id}/cancel` | publisher_or_admin | ReasonRequest | PublishJobView | resource+version |
| 发布 | POST | `/publish-jobs/{id}/retry` | publisher_or_admin | RetryPublishRequest | PublishJobView | key+version |
| 发布 | GET | `/publish-jobs/{id}/attempts` | publisher_or_admin | - | PublishAttempt[] | - |
| 发布 | GET | `/publish-jobs/{id}/export` | publisher_or_admin | - | SignedDownloadView | - |
| 分析 | GET | `/analytics/overview` | analyst_or_admin | AnalyticsQuery | OverviewMetrics | - |
| 分析 | GET | `/analytics/platforms` | analyst_or_admin | AnalyticsQuery | PlatformMetrics[] | - |
| 分析 | GET | `/analytics/contents` | analyst_or_admin | AnalyticsQuery | ContentMetricsPage | - |
| 分析 | GET | `/analytics/costs` | owner_or_analyst_or_admin | CostQuery | CostBreakdown | - |
| 分析 | GET | `/analytics/costs/budget` | owner_or_analyst_or_admin | CostBudgetQuery | CostBudgetStatus | - |
| 分析 | POST | `/analytics/costs/reconcile` | owner_or_analyst_or_admin | CostReconciliationRequest | CostReconciliationReport | - |
| 分析 | POST | `/metrics/import` | analyst_or_admin | multipart MetricsImport | ImportJobView | key+content_hash |
| 分析 | GET | `/metrics/import-jobs/{id}` | analyst_or_admin | - | ImportJobView | - |
| 分析 | POST | `/metrics/import-jobs/{id}/rollback` | analyst_or_admin | RollbackImportRequest | ImportJobView | key+body_hash |
| 分析 | POST | `/metrics/manual` | analyst_or_admin | ManualMetricsRequest | MetricRecord[] | key+body_hash |
| 分析 | POST | `/visibility-observations` | analyst_or_admin | VisibilityObservationRequest | VisibilityObservationView | key+body_hash |
| 分析 | POST | `/visibility-observations/import` | analyst_or_admin | VisibilityImportRequest | VisibilityObservationView[] | key+body_hash |
| 分析 | GET | `/visibility-observations/trend` | analyst_or_admin | VisibilityTrendQuery | VisibilityTrendPoint[] | - |
| 分析 | GET | `/usage/summary` | owner_or_analyst_or_admin | CostQuery | UsageSummary | - |
| 分析 | GET | `/analytics/export` | analyst_or_admin | AnalyticsExportQuery | AnalyticsExportJobView | key+query_hash |
| 系统 | GET | `/audit-events` | tenant_owner | AuditQuery | AuditEventPage | - |
| 系统 | POST | `/tenant-exports` | tenant_owner | TenantExportRequest | TenantExportJobView | key+body_hash |
| 系统 | GET | `/tenant-exports/{id}` | tenant_owner | - | TenantExportJobView | - |

### 错误码

| code | HTTP | 语义 |
|---|---:|---|
| `AUTH_REQUIRED` | 401 | 没有有效会话 |
| `CSRF_INVALID` | 403 | CSRF token 缺失或不匹配 |
| `TENANT_CONTEXT_REQUIRED` | 403 | 会话未选择有效租户 |
| `RESOURCE_NOT_FOUND` | 404 | 资源不存在或不在当前授权范围；统一避免枚举泄露 |
| `PERMISSION_DENIED` | 403 | 资源可见但角色不允许该动作 |
| `STATE_TRANSITION_INVALID` | 409 | 状态转换不允许 |
| `VERSION_CONFLICT` | 409 | 乐观锁版本冲突 |
| `IDEMPOTENCY_CONFLICT` | 409 | 相同幂等键使用了不同请求体 |
| `QUALITY_BLOCKED` | 422 | 质量门禁未通过 |
| `BUDGET_EXCEEDED` | 402 | 租户或任务预算不足 |
| `SCHEMA_VALIDATION_FAILED` | 422 | DTO 或 Skill JSON Schema 校验失败 |
| `ADAPTER_CAPABILITY_UNAVAILABLE` | 422 | 账号或平台不支持所请求能力 |
| `ADAPTER_AUTH_EXPIRED` | 424 | 平台凭证失效 |
| `RATE_LIMITED` | 429 | 限流；返回 Retry-After |
| `AI_PROVIDER_TIMEOUT` | 504 | 模型调用超时 |

## 8. Outbox、队列和幂等

业务事务同时写领域数据和 outbox。Relay 使用 `FOR UPDATE SKIP LOCKED` 领取、processing lease、`jobId=event.id` 投递、失败退避和 lease sweeper。语义至少一次；消费者以 event_id+业务键幂等。关键业务模块禁止绕过 Outbox 直接投递。

HTTP 幂等保存 scope+key+request_hash；相同 hash 返回原结果，不同 hash 返回 IDEMPOTENCY_CONFLICT。发布任务冻结 content_version_id/payload_hash；外部未知态不盲重试。

## 9. 页面与验收

冻结页面数：32。每页必须实现 loading/empty/error/permission/mobile/keyboard，筛选写入 URL。

| ID | 页面 | 权限 | 页面验收 |
|---|---|---|---|
| AUTH-01 | 登录 | public | 错误态不泄露邮箱是否存在 |
| AUTH-02 | 租户选择 | authenticated | 禁用 membership 不可选择 |
| DASH-01 | 工作台 | tenant_member | 筛选进入 URL；无权限卡片不展示 |
| STR-01 | 品牌策略列表 | tenant_member | 写操作仅 strategy_editor_or_admin |
| STR-02 | 品牌策略编辑 | strategy_editor_or_admin | 已发布版本只读 |
| STR-03 | 主题规划 | strategy_editor_or_admin | 无证据主题标记风险，不自动进入生产 |
| STR-04 | 关键词集 | strategy_editor_or_admin | 关键词集内规范化 term 唯一 |
| KNOW-01 | 资料列表 | tenant_member | 失效资料不进入新检索 |
| KNOW-02 | 上传资料 | strategy_or_content_editor_or_admin | 类型、大小、病毒扫描和 SSRF 校验 |
| KNOW-03 | 资料详情 | tenant_member | 原文和 chunk 可回溯 |
| KNOW-04 | 事实裁决 | reviewer_or_admin | 裁决写审计且不覆盖历史 |
| CONT-01 | Brief 列表 | tenant_member | 分页和筛选可复现 |
| CONT-02 | Brief 编辑 | strategy_or_content_editor_or_admin | 至少一平台、一关键词；事实型内容至少一来源 |
| CONT-03 | 内容包列表 | tenant_member | 包状态仅作摘要 |
| CONT-04 | 内容包详情 | tenant_member | 动作以变体状态守卫 |
| CONT-05 | 内容编辑器 | content_editor_or_admin | version 必填；冲突返回 409 |
| CONT-06 | 生成运行 | content_editor_or_admin | 取消恢复前一稳定状态 |
| QUAL-01 | 质量报告 | tenant_member | block/revise 不可提交审核 |
| REV-01 | 审核列表 | reviewer_or_admin | 只展示授权工作区 |
| REV-02 | 审核快照 | reviewer_or_admin | 任何内容 hash 不匹配即拒绝动作 |
| PUB-01 | 平台账号 | publisher_or_admin | 凭证永不回显 |
| PUB-02 | 发布日历 | publisher_or_admin | 仅 approved 变体可操作 |
| PUB-03 | 发布任务 | publisher_or_admin | 幂等且尝试 append-only |
| ANL-01 | 数据总览 | analyst_or_admin | 口径版本和数据更新时间可见 |
| ANL-02 | 指标导入 | analyst_or_admin | 重复维度幂等 |
| ANL-03 | 可见性观察 | analyst_or_admin | 截图走对象存储 |
| ANL-04 | 成本中心 | owner_or_analyst_or_admin | ledger 与供应商账单可对账 |
| SET-01 | 成员与邀请 | tenant_admin_or_owner | 最后一个 owner 不可禁用 |
| SET-02 | 工作区设置 | tenant_admin_or_owner | 至少保留一个 active workspace |
| SET-03 | 平台规则与 Prompt | platform_operator | 发布后不可覆盖 |
| SET-04 | 审计日志 | tenant_owner | append-only；高风险写入失败则业务失败 |
| PLAT-01 | 平台租户管理 | platform_admin | 读取租户内容需限时支持授权 |

## 10. 开发任务

任务固定 T001-T144，共 144 个。每任务包含交付物、文件范围、依赖、验收命令和统一 DoD。

| 里程碑 | 范围 | 出口 |
|---|---|---|
| M0 | T001-T012 | 基础设施、contracts、Outbox、幂等、安全 |
| M1 | T013-T028 | 身份、租户、工作区和策略 |
| M2 | T029-T042 | 知识、RAG 和事实 |
| M3 | T043-T070 | 内容、AI 和六 Skills |
| M4 | T071-T102 | 32 个页面 |
| M5 | T103-T126 | 七平台、审核和发布 |
| M6 | T127-T136 | 数据、成本、审计、可靠性和运维 |
| M7 | T137-T144 | 安全、性能、迁移、E2E 和发布 |

### 启动命令

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
pnpm verify
```

## 11. 开发冻结门禁

- contracts/迁移/OpenAPI/Prompt Schema/文档无漂移。
- 空库 migration+seed、升级和回滚 smoke 通过。
- 全部 JSON Schema 和示例验证通过。
- Mock Brief->7变体->质量->审核->发布/导出->指标 E2E 通过。
- 租户隔离、SSRF、CSRF、XSS、注入、凭证、导出安全阻断项为零。
- API P95<=800ms；100 工作区压测；RPO<=15m/RTO<=60m 恢复演练。
- 32 页面可访问性严重项为零；AC-001..AC-016 全部签字。

需求变化必须新增 ADR/变更单并同步 contracts、迁移、OpenAPI、任务和文档；禁止静默修改冻结规则。
