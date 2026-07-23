# 运行能力审计（2026-07-19）

## 审计方法

逐页核对 Web 调用、API 写入、Outbox 路由、BullMQ 消费者、结果落库和 Docker 实际入口。只有完整走通并产生业务结果的能力标记为“真实可用”；只有类、测试、队列或界面不算完成。

## 已验证真实可用

| 能力 | 运行证据 |
|---|---|
| 知识资料入库 | URL 实测完成安全抓取、解析、1 个分块、1 个 1536 维向量并转为 active |
| 知识资料参与创作 | 快速创建保存 `brief_sources`；生成前混合检索与重排；DeepSeek 输入携带命中片段 |
| 引用回溯 | 生成版本写入 `ai_citations`；资料详情按文章引用显示 1 次 |
| 内容生成 | AI Worker 实际消费 Content Writer 任务，DeepSeek Flash 实测生成母稿和官网变体 |
| 质量检查 | AI Worker 实际消费 Quality Checker 任务并写不可变质量报告 |
| 内容审核 | 提交、领取、通过或退回、审核快照和状态转换均有数据库实现 |
| 身份与企业上下文 | 登录、退出、切换账号、切换企业、会话与权限范围均有真实 API 和数据库状态 |
| 同步分析能力 | 分析查询、手工指标写入、可见性记录与导入、成本查询和对账为同步数据库流程 |

## 完全断开的异步能力

| 能力 | 证据 | 用户影响 | 建议优先级 |
|---|---|---|---|
| 发布任务执行与导出 | `publisher-worker` 有 Worker 类和队列消费者，但无 `main.ts`、独立 Dockerfile；Compose 启动通用健康镜像 | 排期可创建，执行事件进入 `geo-publisher` 后无人消费，任务不会发布或生成导出包 | P0 |
| CSV 指标导入 | API 写入 `analytics.metrics.import_requested.v1`；Analytics Worker 无队列消费者、存储实现和入口 | 页面上传后任务停留 queued，数据不会写入指标表 | P0 |
| 分析导出 | API 写入 `analytics.export.requested.v1`；无运行消费者 | 导出请求不会生成文件 | P1 |
| 租户数据导出 | API 写入 `lifecycle.tenant.export_requested.v1`；Lifecycle Worker 无入口和消费者 | API 任务不会完成；当前也没有对应 Web 页面 | P1 |

## 路由错误或未接线的 AI 能力

| 能力 | 证据 | 用户影响 | 建议优先级 |
|---|---|---|---|
| Topic Planner | API 将事件路由到 `geo-ai`，但 AI Consumer 只接受内容生成和质量检查，对该事件直接抛错；默认模型仍为 `mock-topic-planner` | 主题规划页面可发起任务，但不会得到候选主题 | P0 |
| Fact Checker | Skill、Schema、Repository 和质量管线读取逻辑存在，但没有创建/消费 Fact Checker 运行的入口 | 当前“质量检查”只有 Quality Checker，不包含独立事实核查结果 | P1 |
| GEO Optimizer | 只有 Skill、Prompt、Few-shot 和测试；API/Worker 没有调用点 | GEO 优化器不会改写或评分任何实际内容 | P1 |
| 自动事实抽取 | `FactExtractionService` 可保存受约束事实，但 Knowledge Worker 从不调用它 | 资料能检索和引用，但“关联事实”通常一直为 0，事实裁决页没有自然数据来源 | P1 |

## 部分可用或配置关闭，不应误判为完整能力

| 能力 | 当前真实边界 |
|---|---|
| Material Parser Skill | AI Skill 未进入运行时；实际资料解析由确定性 `packages/parsers` 完成，文件/URL 解析本身真实可用 |
| 图片 OCR | 只有 disabled/mock Provider，无生产 Provider；界面已停止开放图片上传 |
| 七平台 Adapter | Render、Export 和通用 HTTP API Adapter 有真实实现；但 Publisher Worker 未启动，且 API 模式依赖另行提供的平台代理端点，不是内置官方 OAuth 集成 |
| 邀请邮件 | SMTP Adapter 有真实实现；默认 `EMAIL_TRANSPORT=disabled` 时不会发送，属于配置关闭 |
| 数据保留清理 | 有纯 Worker 类，但没有运行入口或定时调度，当前不会自动执行 |

## 建议修复顺序

1. 先补 Publisher 入口、配置、Dockerfile、凭证解密接线和 export-only 端到端测试。
2. 给 Topic Planner 增加独立事件处理器，使用真实模型配置并写回 `completeRun`。
3. 补 Analytics Worker 的 Postgres/Object Storage 端口和两个事件消费者。
4. 将 Fact Checker 接入质量检查编排，再接 GEO Optimizer；不要把两者伪装成现有 Quality Checker 已覆盖。
5. 在知识入库完成后增加可审计的事实候选抽取，再开放自动事实裁决工作流。
6. 最后补 Lifecycle Worker 入口与保留任务调度。
