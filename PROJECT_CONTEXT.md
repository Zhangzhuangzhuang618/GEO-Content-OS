# GEO Content OS - 项目上下文

> 企业级 GEO 多平台内容生产系统（MVP v1.0）
> 文档基线日期：2026-07-15
> 上下文版本：v2.1（全面开发冻结修订版）

## 0. 开发冻结声明

本文件用于快速建立开发上下文。可执行事实源优先级：`packages/contracts/`（枚举、状态、权限、错误、事件、API/Skill Schema）> `apps/api/src/database/migrations/`（数据库）> 代码生成 OpenAPI 3.1（接口）。五份 DOCX 用于解释、任务和验收。发生冲突必须停止局部实现，先修事实源并同步文档。

## 1. 产品范围

GEO Content OS 是 SaaS 多租户内容生产系统，闭环为策略/知识 -> 主题/Brief -> 母稿和九平台变体 -> 事实/GEO/质量 -> 冻结审核 -> API 发布或确定性导出 -> 指标与成本。每个发布版本必须追溯 source chunk、content version、Prompt、model、rules、review 和 publish attempt。

### MVP 平台

| code | 平台 | 形态 | 交付 |
|---|---|---|---|
| official_site | 官网 | SEO 长文/专题页 | API 或 HTML/Markdown 导出 |
| baijiahao | 百家号 | 图文/动态 | 能力探测后 API；否则导出 |
| sohu | 搜狐号 | 图文 | 托管浏览器发布；否则确定性导出 |
| lieju | 列举网 | 分类信息/图文 | 托管浏览器发布；否则确定性导出 |
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
workers/{knowledge,ai,outbox-relay,publisher,baijiahao-browser,sohu-browser,lieju-browser,analytics,lifecycle}
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

### 官网自动化（ADR-0021）

只对 `official_site` 生效。项目策略开启且变体绑定 active API 账号时，生成后自动执行质量门禁：GEO>=85、事实>=90、品牌>=90、可读性与安全>=85、问题覆盖>=80、平台适配>=80，任一 BLOCK 或非 pass 决策均失败。失败按问题清单最多重写 3 次，仍失败进入 `manual_required`；通过后不进入人工审核，直接创建 `origin=official_site_automation` 的发布任务。官网发布调用总计最多 3 次，幂等键为 `official-site:<variant_id>:<content_version_id>`。人工在官网后台删除文章不反向同步。

### AI 可见度实验（ADR-0022）

AI 可见度实验是独立于八个平台发布流程的分析域。问题集按品牌认知、探索、推荐、比较、科普和采购六类意图版本化；除品牌认知题外，其他问题不得包含目标品牌或别名。运行由 `geo-ai` 队列异步执行，保存逐题原始回答、明确排名、品牌识别状态、竞品、模型返回网址和版本化分数。自然提及率只统计探索、推荐、科普和采购题；品牌认知区分正确识别、未识别、疑似误认和不确定；排名只接受明确名次或有序列表位置；内容机会必须同时满足高商业价值、目标品牌未自然出现且至少一个竞品出现。首期只启用现有 DeepSeek Adapter，每题单样本，结果用于内部对比，不宣称为行业标准或联网搜索结果。

### 官网每日十篇（ADR-0023 / ADR-0032）

只对启用每日计划的 `official_site` 项目生效。系统每天 00:00（Asia/Shanghai）幂等创建一个批次，目标固定 10 篇、每次尝试的候选上限固定 30 篇。每个候选继续执行 ADR-0021 机器门禁和最多 3 次重写；仍不通过则淘汰并自动创建新候选补位，不得降低质量阈值。达到 10 篇时按 08:00、09:30、11:00、12:30、14:00、15:30、17:00、18:30、20:00、21:30 排入当天官网发布计划；如果候选耗尽仍不足 10 篇，已经合格的内容也先排期，批次再进入需要处理。重复巡检和消息重放不得重复创建批次、内容或发布任务；跨日仍未完成的批次停止并要求处理。普通单篇官网内容仍在质检通过后立即发布，其他八个平台不变。

### 百家号自动化（ADR-0028 / T145）

百家号使用独立策略、运行、每日批次和浏览器会话表，不迁移或复用官网自动化表。`official_site_derived` 仅监听已成功发布且有公开 URL 的官网自动化文章，复用事实与证据并执行一次百家号定向改写；不适合的信息记录为跳过，百家号失败不反向影响官网。`independent` 使用项目知识、品牌和引用独立生成；派生策略的独立补位默认关闭，启用后最早在首个排期前一小时启动。所有候选执行 GEO>=85、事实>=90、品牌>=90、可读性与安全>=85、问题覆盖>=80、平台适配>=80、任一 BLOCK/非 pass 禁止发布、最多重写 3 次的冻结门禁。

发布由独立 `baijiahao-browser` 进程完成：每账号并发为 1，扫码登录且不保存密码，加密 storage state 配合 `tmpfs` Profile 恢复；验证码、登录失效或页面签名变化立即停止。未知提交必须先从内容列表按标题、指纹和时间核验。媒体资产必须与内容版本同租户同项目、记录无推广水印并通过哈希复核后才以内存文件上传；无媒体时选择无封面。浏览器 E2E 只允许访问本机仿真页面。

### 自动配图（ADR-0030 / T148）

文章通过既有官网或百家号冻结质量门禁后，DeepSeek 只负责生成两个匿名编辑插画场景计划，封面由服务端确定性模板生成，正文图由 Cloudflare Workers AI FLUX 生成并由 Cloudflare 视觉模型执行文字、企业名称、Logo/水印、电话、安全性、相关性和“伪装真实证据”门禁。通过后叠加“AI示意图”。任一环节失败时改用模板图；存储整体失败时无图继续发布，图片不得阻断合格文章。图片通过独立关系绑定不可变内容版本，官网只发布持久 CDN 地址，百家号按素材 ID 上传。不使用 Gemini，不修改或伪造文章质量结论，不降低 ADR-0021/ADR-0028 阈值。

### 搜狐号发布（ADR-0034 / T150）

搜狐号作为第八个平台进入普通生成、质检、审核和排期主链路。发布由独立 `sohu-browser` 进程完成：支持微信扫码、临时账号密码和临时手机验证码登录；第三方登录输入不落库，认证后只保存加密 storage state。账号串行，填充 Quill 正文与摘要、上传配图，并如实选择“包含AI创作内容”，不得声明原创。提交后持续从内容管理页对账，只有远端为已发布才完成任务；未知态先核验后重试，重复匹配进入人工处理。自动测试只访问本地仿真页面。ADR-0037 另为搜狐号增加独立日批全链路，但不从官网文章派生。

HOTFIX-20260814-01 已按搜狐真实页面修正两阶段微信登录、OAuth 绑定失败识别、实名认证发文权限提示、内容首页进入编辑器、上传管理器确认、非 `button` 发布控件、发布完成等待和异步内容列表对账。同名草稿不作为远端发布结果；真实低频灰度验证已进入搜狐审核中，未知或本地假失败仍必须先对账，禁止直接重复提交。

HOTFIX-20260814-02 针对搜狐接受发布后内容列表的短暂可见性延迟，增加 3 次、每次间隔 2 秒的只读对账轮询。发布按钮仍只点击一次，轮询不得重新填写、上传或提交；全部查询为空才保留未知态。

HOTFIX-20260814-03 修正搜狐号账号卡片的登录交互：用户点击“搜狐号登录”后直接发起扫码会话 POST，不再先以首次会话 GET 的预期 404 阻断。登录面板仍保留手动重试和登录态核验。

### 列举网发布（ADR-0035 / T151）

列举网作为第九个平台进入普通生成、质检、审核和排期主链路。发布由独立 `lieju-browser` 进程完成：支持 QQ 扫码和临时用户名密码登录；官方没有手机验证码登录入口，第三方登录输入不落库，认证后只保存加密 storage state。账号串行，固定填写广州“生活服务 → 搬家”分类信息表单。联系人、电话、地址、区域和搬家子类属于加密账号配置，不进入 Prompt、日志或审计；正文不得包含联系方式。普通会员的腾讯交互验证码必须转人工，不绕过；只有免验证码权益生效且页面未出现验证码时才允许无人值守提交。提交后从会员中心对账，待审核保持 `processing`，只有公开信息链接可访问且标题匹配才记为 `published`。ADR-0037 另为列举网增加独立日批全链路。

HOTFIX-20260814-04 根据真实列举网页面把默认发布入口从错误的“商务服务 → 物流/货运” `/5/104` 修正为“生活服务 → 搬家” `/5/73`，同步搬家子类、生成提示词和提交后跳转判定。图片成功生成预览后页面会清空文件输入框，Worker 同时接受保留文件或非空预览，避免把上传成功误判为失败。旧账号的 1–6 类别值继续按搬家子类解释；旧值 7 无对应搬家类别，必须重新配置后才能发布。

ADR-0038 / T154 将列举网新账号切换为官方发布 API：API Key、广州区域和联系方式加密保存，固定以 GBK 表单发布到 `city_id=5`、`fid=73`，公开 HTTPS 图片最多 5 张。官方资料未提供状态查询或幂等键，因此 Publisher 在请求前写入唯一提交预留；未知响应、进程中断和消息重放均停止自动重投并转人工核实。只有返回公开列举网链接且页面标题匹配时才自动完成发布，明确成功但不能公开核验时保持处理中并允许人工确认。旧账号继续兼容 `lieju-browser`，不自动迁移凭据。

HOTFIX-20260816-01 明确搜狐号与列举网日批的部分成功语义：候选耗尽不会撤销已经通过冻结门禁并创建的排期任务，批次只把未完成名额转为 `attention_required`；管理界面和错误提示同时显示已排期数量与剩余缺口。质量门禁、重写次数和发布状态机不变。

HOTFIX-20260816-02 恢复百家号自动化的无手工排期体验：管理界面根据每日合格目标自动生成并只读展示 `daily_schedule_times`，目标为 1 时沿用 10:00，目标为 10 时沿用官网固定十时段，中间目标均匀取样。API 仍持久化明确时段，AI Worker 排期、幂等、质量门禁和发布状态机不变。

HOTFIX-20260816-03 将相同的自动时段规则扩展到搜狐号和列举网：当前具备全链路日批的官网、百家号、搜狐号和列举网均无需手填发布时间。头条号、知乎、小红书、微信公众号和抖音仍是导出或人工发布账号，没有日批策略，本 Hotfix 不扩展其发布能力。API 继续持久化明确时段，质量门禁、候选上限、重写次数和发布状态机不变。

HOTFIX-20260816-04 补齐九平台创作入口与用户待处理闭环：首页及内容、策略、审核、发布和数据页面统一展示官网、百家号、搜狐号、列举网、头条号、知乎、小红书、微信公众号和抖音，并将旧的 8 平台响应上限修正为 9。内容列表新增服务端“只看待处理”筛选，首页异常卡片进入完整待处理队列；搜狐号和列举网日批返回逐篇失败原因及内容、质量报告、发布任务入口。状态机仍以真实质量和发布结果为准，不把失败伪装成成功，也不降低冻结门槛。

HOTFIX-20260817-01 为搜狐号、列举网及后续平台补充项目关键词适用范围的一键同步能力：同步只追加所选平台，不删除既有平台范围、不启用停用关键词，也不重新评估或自动重跑旧批次。列举网账号密码登录改为先识别 `www.lieju.com` 会员态，再进入 `post.lieju.com` 发布页复核，避免跨子域成功登录被误报超时；交互验证码与普通超时分别返回可处理错误。三个 Playwright 发布容器的会话目录统一挂载为镜像内 `pwuser` 的 UID/GID 1001，避免生产 Compose 因目录不可写而在登录建档时误报失败。

HOTFIX-20260817-02 修正百家号严格成功回执被随后内容列表核验异常覆盖的问题：发布接口已返回业务成功和文章 ID 后，即使内容管理页暂时无法形成可验证列表，也保留 `processing` 回执并等待后续对账，不再暂停整个账号的托管浏览器会话。已取得文章 ID 的任务只允许继续对账，禁止因核验超时重新提交；验证码、登录过期、重复匹配和提交前页面签名门禁保持不变。

HOTFIX-20260817-03 为搜狐号和列举网补充“重试今日批次”闭环：仅当今日批次因 `AUTOMATION_PREREQUISITE_MISSING` 停止且尚未创建任何候选时，发布管理员可在修复品牌、规则、关键词或知识资料后显式恢复原批次。请求使用幂等键与批次版本并记录审计；候选已开始、候选耗尽、发布失败、其他状态和历史日期均不可通过此入口重置，旧内容和旧质量报告不会重新评估。

HOTFIX-20260817-04 补齐浏览器发布任务达到重试上限后的未发布收尾：人工在百家号、搜狐号或列举网后台按标题确认没有创建内容后，可将任务结束为 `cancelled`，同时停止对应自动化运行并把日批条目转为 `retired`。该动作只适用于已经达到尝试上限、需要人工核实且没有远端文章 ID 的失败任务；历史尝试保持不变，不再次请求外部平台。“确认已经发布”仍必须提供有效公开 URL。

HOTFIX-20260817-05 修正搜狐号与列举网日批的两处生成运行时错误：`get_platform_rules` 改为复用统一九平台枚举，避免 `sohu`、`lieju` 被工具参数校验拒绝；浏览器平台自动化改为写入 Outbox 的实际列 `next_attempt_at`。新增 SchemaGuard 全平台覆盖和 Outbox SQL 回归。质量门禁、候选上限和旧批次状态不变，已耗尽批次不会因部署自动重跑。

HOTFIX-20260817-06 统一官网、百家号、搜狐号和列举网的“保留历史候选、重新发起新尝试”恢复能力：候选耗尽后创建下一 `attempt_no`，旧候选、旧质量报告、旧发布任务和审计保持不变；新尝试只按当天跨尝试累计结果补足缺口，发布失败继续处理原任务而不生成替代文章。前置资料缺失且零候选仍使用原地重试。后续平台接入日批时必须复用同一契约和计数规则；当前无日批能力的平台不新增虚假入口。

### 托管浏览器临时凭据登录（ADR-0036 / T152）

搜狐账号密码、手机号、图形码和短信码，以及列举网用户名密码，只在单次同步请求和 Worker 当前浏览器内存中存在，不进入平台账号凭据、数据库、Outbox、幂等记录、审计详情、日志或测试快照。短信只能由用户明确点击发送；图形验证码必须人工查看和输入。Worker 重启后未完成挑战失效。新增登录方式不改变质量门禁、发布状态判定或真实发布授权边界。

### 搜狐号与列举网全链路自动化（ADR-0037 / T153）

搜狐号与列举网按平台和账号隔离保存自动化策略、运行、每日批次和批次项，只执行独立生成，不复用官网或百家号批次。每篇候选执行 GEO>=85、事实>=90、品牌>=90、可读性与安全>=85、问题覆盖>=80、平台适配>=80、任一 BLOCK/非 pass 禁止发布、最多重写 3 次的冻结门禁；重写必须使用当前内容和当前质量报告问题。通过后进入既有自动配图、排期和对应浏览器发布，对账、验证码与人工确认规则不变。候选耗尽时已合格文章先排期，批次再进入需要处理。

列举网独立内容允许真实、具体、有边界地介绍本企业服务范围、流程、可核验能力和适用场景，并可自然提示用户通过页面联系方式咨询或提交需求。正文仍禁止电话、微信、QQ、网址、极限词、排名、竞品贬损、虚假价格、虚假资质、虚构案例、客户评价和结果保证；联系人与电话只由加密账号配置在发布表单中填写。

### 官网媒体随文上传（ADR-0031 / T149）

Windows 服务器上的私有 MinIO 仅作为生成图片的内部暂存，不要求公网地址。官网 API 账号声明媒体上传能力后，Publisher 在发布文章前从 MinIO 读取素材，复核对象 URI、大小和 SHA-256，再使用同一 Bearer Token 把 JPEG 二进制上传到官网；官网按内容哈希幂等保存并返回自身 HTTPS 地址，Publisher 使用该地址重新渲染文章后发布。上传失败按 ADR-0030 无图降级，不阻断合格文章；百家号既有内存文件上传方式不变。`GENERATED_MEDIA_PUBLIC_BASE_URL` 只保留为旧 CDN 兼容回退，采用随文上传时留空。

### 官网当日批次重发（ADR-0024 / ADR-0032）

当日批次因 30 篇候选耗尽仍未补足 10 篇而进入 `attention_required` 后，发布管理员可正式发起下一次当日尝试。旧批次和候选完整保留并标记 `cancelled`，新批次使用递增 `attempt_no`，先排期当天全部尝试中已合格或保留的内容，只生成达到 10 篇所需的缺口；每次仍固定最多 30 篇候选且不降低 ADR-0021 门禁。已合格、已排期、已发布按日期跨尝试汇总，候选和淘汰数按当前尝试统计；发布失败只重试原发布任务，不重新生成内容。同一策略和日期同时最多一个活动批次；操作使用 Idempotency-Key、批次版本和审计日志防止重复或并发误操作。其他失败原因、其他日期和其他平台不可使用该入口。

### 官网分阶段生成与证据计分（ADR-0025）

只含 `official_site` 的生成任务分为“正文”和“FAQ/发布字段”两个阶段：模型先返回浅层标题、摘要和正文块，正文成功后立即保存；正文硬门槛仍为 1,300–2,500 个有效字符，提示词使用 1,500–2,200 个有效字符作为安全目标，长度不足修复必须扩展实质内容，不得重复或灌水。随后模型只根据正文生成 4–6 个 FAQ，slug、meta description、Schema.org 和引用映射由服务端确定性组装。FAQ 结构失败最多独立尝试 3 次，不重新生成已保存正文。官网证据分按声明与引用原文的实际支持质量和风险权重计算，不再按引用条数加分；高风险数字必须在证据中精确出现。ADR-0014 第一方资料规则、ADR-0021 门禁和其他八个平台流程不变。

### 官网当日批次人工终止（ADR-0026）

发布管理员可终止当天最新的 `running` 官网每日批次。批次进入 `cancelled`，调度器停止补题和排期；该批次尚未完成的生成、质检和重写运行通过既有终态协作退出，已在途模型请求的结果不得继续落库或发布。处理中候选转为 `retired`，已合格但尚未排期的候选转为 `reserve`，历史记录和成本保留。终止请求使用 Idempotency-Key 与批次版本；已排期或已发布内容不在此入口处理。系统不会自动恢复当日已终止批次，但发布管理员可以显式“重新发起今日批次”创建递增尝试号的新批次；次日计划仍正常创建。

### 官网正文定向补写与质检语义重试（ADR-0027）

官网首稿使用“结构预算 + 真实门禁后果”的正向提示，目标为 1,700–2,100 个有效字符，1,300–2,500 硬门槛不变。首稿仅长度不足时不再整篇重写，而是保留已有正文并按服务端精确缺口最多定向补写两轮；补写只允许新增段落或清单，服务端拒绝重复、越界和未知引用。其他质量问题仍先完整修复一次。Quality Checker 输出通过 JSON Schema 但违反高风险事实 BLOCK、GEO 分数或 decision 不变量时，运行时携带明确必选位置再执行一次；第二次仍不合法则失败，禁止自动放行。

## 5. 数据模型

冻结基线表数为 57；ADR-0010 新增账号定向生成字段和约束，ADR-0017 增加 URL 资料唯一性和历史去重，ADR-0020 为平台账号增加可配置发布后台地址，ADR-0021 新增官网自动化策略与运行表，ADR-0022 新增 AI 可见度问题集、问题、运行和逐题响应表，ADR-0023 新增官网每日批次及候选关联表，ADR-0024 为每日批次增加同日尝试编号和单活动批次约束，ADR-0028 新增 7 张百家号策略、运行、每日批次、浏览器会话、发布及诊断制品表，T146 为关键词增加多搜索意图数组并保留首项兼容字段，ADR-0029 新增关键词表格预检和候选暂存表，ADR-0030 新增内容配图运行和不可变素材关联表，ADR-0034 新增 3 张搜狐浏览器发布表，ADR-0035 新增 3 张列举网浏览器发布表，ADR-0037 新增 4 张搜狐号与列举网共用且按平台隔离的自动化策略、运行和每日批次表，ADR-0038 新增列举网官方 API 提交预留与状态表。当前可执行表数为 87，迁移序号为 0048。所有业务主键/API ID 为 UUID；content_versions.content_json 是内容唯一权威；append-only 表由数据库 trigger 保护。

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
| `keywords` | 关键词、多搜索意图和平台范围；首项同步到兼容字段 `intent` |
| `keyword_import_jobs` | 关键词 XLSX 预检、选择、异步导入进度和错误 |
| `keyword_import_candidates` | 预检后的确定性主关键词、同义词及结构化导入元数据 |
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
| `content_media_runs` | 质量通过后配图计划、供应商、模型、状态与诊断 |
| `content_media_assets` | 内容版本与合格封面/正文素材的不可变关联和图像质量报告 |
| `content_block_locks` | 当前变体的段落锁 |
| `generation_runs` | Skill/模型运行记录 |
| `ai_citations` | 内容 claim 到 chunk 的精确映射 |
| `fact_check_results` | 每次运行的 claim 判定 |
| `fact_evidences` | Fact Checker 实际证据；unsupported 不写行 |
| `quality_reports` | 不可变质量检查报告 |
| `prompt_versions` | 不可覆盖 Prompt 版本；`semantic_version` 映射数据库 `version`，整数 `lock_version` 映射 API `version` |
| `platform_rule_versions` | 九平台硬约束版本；`semantic_version` 映射数据库 `version`，整数 `lock_version` 映射 API `version` |
| `model_rate_cards` | 模型能力和费率版本 |
| `review_snapshots` | 不可变审核快照头 |
| `review_snapshot_variants` | 审核范围和精确内容版本 |
| `review_snapshot_citations` | 审核时冻结的引用集合 |
| `review_requirements` | 加签和必需审核人 |
| `review_actions` | 审核动作时间线 |
| `platform_accounts` | 平台账号和能力 |
| `official_site_automation_policies` | 项目级官网机器质检、自动重写和自动发布开关；阈值及次数由约束固定 |
| `official_site_automation_runs` | 官网变体自动化状态、当前版本、重写次数、质量报告、发布任务和错误 |
| `official_site_daily_batches` | 官网每天每项目唯一的十篇生产与发布批次 |
| `official_site_daily_batch_items` | 每日候选与 Brief、内容包、变体、版本及发布任务的状态关联 |
| `media_assets` | 图片、视频和证据截图元数据 |
| `publish_jobs` | 排期和发布状态 |
| `publish_attempts` | 不可变发布尝试 |
| `export_artifacts` | 无 API 时的可下载导出包 |
| `import_jobs` | 指标导入批次 |
| `metric_records` | 平台指标事实 |
| `visibility_observations` | 问答/搜索可见性观察 |
| `analytics_export_jobs` | 分析数据异步导出任务 |
| `usage_ledger` | 全成本 append-only 用量账本 |
| `idempotency_records` | HTTP 写请求幂等结果；平台级全局写入允许空 tenant，并以 NULLS NOT DISTINCT 保证唯一 |
| `outbox_events` | 事务事件箱和投递租约 |
| `audit_events` | 不可变审计事件；平台级全局配置事件允许空 tenant |
| `tenant_export_jobs` | 租户数据导出和删除前归档 |

### 审核冻结

review_snapshot 固定 brand_profile、prompt_version、model_key、platform_rules_hash、quality_rules_hash；review_snapshot_variants 固定 variant/content_version/content_hash/platform_rule/quality_report；review_snapshot_citations 固定引用。决策前重算 snapshot_hash。

### Fact Checker

`fact_check_results` 记录每次 claim 判定；`fact_evidences` 仅记录真实证据。unsupported 必须 `evidences=[]`。claim_hash 由服务端规范化后计算，唯一键 `(tenant_id,generation_run_id,variant_id,claim_hash)`。

### 全成本

usage_ledger 归属 tenant/workspace/project/package/variant/generation_run，类别为 llm/embedding/rerank/ocr/storage/queue/platform_api/manual_adjustment；只追加、冲正新行。

## 6. AI、Skills 与 RAG

核心 Skills：`material-parser`, `content-writer`, `fact-checker`, `topic-planner`, `geo-optimizer`, `quality-checker`。每个 Skill 使用 Draft 2020-12 JSON Schema、版本化 Prompt/Few-shot、Tool 白名单和统一 SkillResult Envelope。

RAG：ingest -> normalize -> chunk(500..900,overlap=80) -> PostgreSQL FTS(ts_rank_cd)+pgvector -> fuse -> rerank -> diversify -> cite。URL 按 ADR-0018 保存登记时抓取快照，解析与重建索引优先读取该快照。MVP 不称 BM25。强制 tenant/workspace/project/trust/effective/status 过滤。

真实 provider_model_id、能力和费率由配置/model_rate_cards 提供；文档中的 flash/pro 是逻辑 model_key。

## 7. API 约定

Base `/api/v1`；JSON；UTC；cents；cursor 分页；Zod DTO；OpenAPI 代码生成；写操作 CSRF+Idempotency-Key；所有可变资源返回 version。

冻结基线原为 114 个端点；ADR-0002 为 REV-01 领取闭环新增 1 个端点，ADR-0003 为 ANL-02 批次回滚新增 1 个端点，ADR-0004 为 ANL-03 批量导入和趋势查询新增 2 个端点，ADR-0005 为 ANL-04 预算查看和供应商账单对账新增 2 个端点，ADR-0006 为 SET-01 邀请记录补充 1 个只读端点，ADR-0016 为 KNOW-02 URL 表格预检新增 1 个端点，ADR-0019 为 PUB-01 平台账号编辑、恢复和删除新增 3 个端点，ADR-0021 为官网项目自动发布策略新增 2 个端点，ADR-0022 为 AI 可见度问题集和实验运行新增 5 个端点，ADR-0024 为官网当日批次重发新增 1 个端点，ADR-0026 为官网当日批次人工终止新增 1 个端点，ADR-0028 增加百家号自动化公开端点，ADR-0029 增加 4 个关键词分页与表格导入端点，后续 Hotfix 补充配图恢复等既有流程端点，并以 HOTFIX-20260805-11 增加百家号未知发布结果人工处置端点、HOTFIX-20260808-01 增加百家号终态重新对账端点，ADR-0033 增加平台企业所有者邀请重发端点，ADR-0034 增加搜狐号浏览器会话 3 个端点，ADR-0035 增加列举网浏览器会话 3 个端点，ADR-0037 增加搜狐号与列举网自动化策略读写 2 个端点，HOTFIX-20260817-01 增加项目关键词平台范围同步端点，HOTFIX-20260817-03 增加浏览器平台零候选日批重试端点，ADR-0039 增加百家号和浏览器平台保留历史日批重发 2 个端点，当前可执行端点数为 159。ADR-0036 只扩展既有登录请求体，不增加端点。ADR-0007、ADR-0008 与 ADR-0009 分别补齐既有 SET-03、SET-04 和 PLAT-01 端点的可执行契约，不增加端点；ADR-0009 同时以 `tenants.version` 修正暂停/恢复的乐观锁缺口。ADR-0010 接通 AI Worker 和账号定向生成，ADR-0020 增加发布后台跳转地址与页面入口，ADR-0023 扩展既有官网自动发布策略并增加后台批次调度，均不增加公开端点。

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
| 平台 | POST | `/platform/tenants/{id}/owner-invitation/resend` | platform_admin | - | TenantView | key+body_hash |
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
| 策略 | GET | `/keyword-sets/{id}/keywords` | tenant_member | KeywordListQuery | KeywordPage | - |
| 策略 | POST | `/keyword-sets/{id}/imports/preflight` | strategy_editor_or_admin | multipart KeywordImportPreflight | KeywordImportJobView | key+body_hash |
| 策略 | POST | `/keyword-sets/{id}/imports/{importId}/commit` | strategy_editor_or_admin | CommitKeywordImportRequest | KeywordImportJobView | key+body_hash |
| 策略 | GET | `/keyword-sets/{id}/imports/{importId}` | tenant_member | - | KeywordImportJobView | - |
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
| 发布 | PATCH | `/platform-accounts/{id}` | publisher_or_admin | UpdatePlatformAccountRequest | PlatformAccountView | resource+version |
| 发布 | POST | `/platform-accounts/{id}/refresh` | publisher_or_admin | RefreshAccountRequest | PlatformAccountView | resource+version |
| 发布 | POST | `/platform-accounts/{id}/test` | publisher_or_admin | - | CapabilityView | resource+version |
| 发布 | POST | `/platform-accounts/{id}/disable` | publisher_or_admin | ReasonRequest | PlatformAccountView | resource+version |
| 发布 | POST | `/platform-accounts/{id}/restore` | publisher_or_admin | - | PlatformAccountView | resource+version |
| 发布 | DELETE | `/platform-accounts/{id}` | publisher_or_admin | - | PlatformAccountView | resource+version |
| 发布 | GET | `/platform-accounts/{id}/official-site-automation` | publisher_or_admin | - | OfficialSiteAutomationPolicyPage | - |
| 发布 | PUT | `/platform-accounts/{id}/official-site-automation` | publisher_or_admin | OfficialSiteAutomationPolicyRequest | OfficialSiteAutomationPolicyView | expected_version |
| 发布 | POST | `/platform-accounts/{id}/official-site-automation/daily-batch/cancel` | publisher_or_admin | OfficialSiteDailyBatchCancelRequest | OfficialSiteAutomationPolicyView | key+body_hash |
| 发布 | POST | `/platform-accounts/{id}/official-site-automation/daily-batch/restart` | publisher_or_admin | OfficialSiteDailyBatchRestartRequest | OfficialSiteAutomationPolicyView | key+body_hash |
| 发布 | GET | `/platform-accounts/{id}/baijiahao-automation` | publisher_or_admin | - | BaijiahaoAutomationPolicyPage | - |
| 发布 | PUT | `/platform-accounts/{id}/baijiahao-automation` | publisher_or_admin | BaijiahaoAutomationPolicyRequest | BaijiahaoAutomationPolicyView | expected_version |
| 发布 | POST | `/platform-accounts/{id}/baijiahao-automation/daily-batch/restart` | publisher_or_admin | BaijiahaoDailyBatchRestartRequest | BaijiahaoAutomationPolicyView | key+body_hash |
| 发布 | GET | `/platform-accounts/{id}/content-automation` | publisher_or_admin | - | BrowserPlatformAutomationPolicyPage | - |
| 发布 | PUT | `/platform-accounts/{id}/content-automation` | publisher_or_admin | BrowserPlatformAutomationPolicyRequest | BrowserPlatformAutomationPolicyView | expected_version |
| 发布 | POST | `/platform-accounts/{id}/content-automation/daily-batch/retry` | publisher_or_admin | BrowserPlatformDailyBatchRetryRequest | BrowserPlatformAutomationPolicyView | key+body_hash |
| 发布 | POST | `/platform-accounts/{id}/content-automation/daily-batch/restart` | publisher_or_admin | BrowserPlatformDailyBatchRestartRequest | BrowserPlatformAutomationPolicyView | key+body_hash |
| 发布 | GET | `/platform-accounts/{id}/baijiahao-browser-session` | publisher_or_admin | - | BaijiahaoBrowserSessionView | - |
| 发布 | POST | `/platform-accounts/{id}/baijiahao-browser-session/login` | publisher_or_admin | - | BaijiahaoBrowserLoginView | resource+version |
| 发布 | POST | `/platform-accounts/{id}/baijiahao-browser-session/reauth` | publisher_or_admin | - | BaijiahaoBrowserLoginView | resource+version |
| 发布 | GET | `/platform-accounts/{id}/sohu-browser-session` | publisher_or_admin | - | BaijiahaoBrowserSessionView | - |
| 发布 | POST | `/platform-accounts/{id}/sohu-browser-session/login` | publisher_or_admin | SohuBrowserLoginRequest | BaijiahaoBrowserLoginView | resource+version |
| 发布 | POST | `/platform-accounts/{id}/sohu-browser-session/reauth` | publisher_or_admin | SohuBrowserLoginRequest | BaijiahaoBrowserLoginView | resource+version |
| 发布 | GET | `/platform-accounts/{id}/lieju-browser-session` | publisher_or_admin | - | BaijiahaoBrowserSessionView | - |
| 发布 | POST | `/platform-accounts/{id}/lieju-browser-session/login` | publisher_or_admin | LiejuBrowserLoginRequest | BaijiahaoBrowserLoginView | resource+version |
| 发布 | POST | `/platform-accounts/{id}/lieju-browser-session/reauth` | publisher_or_admin | LiejuBrowserLoginRequest | BaijiahaoBrowserLoginView | resource+version |
| 发布 | POST | `/publish-jobs` | publisher_or_admin | CreatePublishJobRequest | PublishJobView | key+body_hash |
| 发布 | GET | `/publish-jobs` | publisher_or_admin | PublishJobQuery | PublishJobPage | - |
| 发布 | GET | `/publish-jobs/{id}` | publisher_or_admin | - | PublishJobDetail | - |
| 发布 | POST | `/publish-jobs/{id}/cancel` | publisher_or_admin | ReasonRequest | PublishJobView | resource+version |
| 发布 | POST | `/publish-jobs/{id}/retry` | publisher_or_admin | RetryPublishRequest | PublishJobView | key+version |
| 发布 | POST | `/publish-jobs/{id}/resolve-unknown` | publisher_or_admin | ResolveUnknownPublishRequest | PublishJobView | key+version |
| 发布 | POST | `/publish-jobs/{id}/reconcile` | publisher_or_admin | ReconcilePublishJobRequest | PublishJobView | key+version |
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

ADR-0010 后，`ai-worker` 是真实 BullMQ 消费进程，不再使用通用 health 占位。除 ADR-0025 的官网专用分阶段流程外，内容生成通过 Content Writer Skill 一次返回母稿和全部平台变体；平台变体运行记录继续作为状态与追溯记录。Compose 默认要求每个目标平台恰好一个 active 平台账号，并将账号 ID 固化到 `content_variants.platform_account_id`。模型 Key 只从环境变量注入，平台账号凭证继续加密存储且不得进入 Prompt。

ADR-0011 后，Content Writer 使用发布级 Prompt 1.1.1（ID `25000000-0000-4000-8000-000000000003`），并按事件中的 `model_policy` 选择模型：fast/balanced 使用 DeepSeek V4 Flash，quality 使用 V4 Pro。AI Worker 必须加载 `prompt_versions` 中被运行记录引用的已发布提示词；balanced/quality 首稿未达到平台篇幅、结构、重复度和事实边界门禁时最多完整重写一次，仍不达标则以 `CONTENT_QUALITY_INSUFFICIENT` 失败，不得把短占位稿持久化为可发布内容。旧事件缺少 `model_policy` 时按 balanced 处理。企业内部确认事实只能作为明确的第一方口径，不得伪装成公开独立证据，也不得仅凭自有车辆、正式员工或社保属性推断培训、服务质量、法律结果或竞争优势。

ADR-0012 后，Content Writer 使用 Prompt 1.1.2（ID `25000000-0000-4000-8000-000000000004`）。输出 `citation_map` 只允许记录由输入 citations 直接支持的事实，每个映射必须至少包含一个输入已提供的 citation_id；无引用资料时所有 `citation_map` 必须为空。空引用映射在 JSON Schema 阶段进入现有一次自动修复，不得在模型已完成生成后直接把整个内容包判为失败，也不得通过编造引用完成修复。

ADR-0013 后，`content.variant.quality_check_requested.v1` 由 AI Worker 实际消费，并通过已发布 Quality Checker Prompt 1.0.0（ID `25000000-0000-4000-8000-000000000005`）生成不可变质量报告。模型只返回质量数据；租户范围、内容版本与 hash、运行、trace、usage、状态转换和审计均由服务端持有。CONT-04 与 QUAL-01 均可发起首次质量检查并自动刷新，只有当前内容版本检查通过的变体可提交审核。全局应用头部必须提供当前账号与企业信息，以及切换企业、切换账号和退出登录入口；换号前必须撤销当前会话。

ADR-0014 后，已发布 `brand_profile` 是企业授权确认的第一方来源。官网稿中与该档案一致的经营事实（例如自有资源、服务范围和正式用工信息）无需再提供互联网公开链接，也不得仅因 `citation_map` 为空要求重复“官方确认”；系统仍保留品牌档案版本、内容版本和审核记录作为内部溯源。资质、认证、荣誉、监管口径、第三方统计、竞品比较、客户结果以及超出品牌档案的陈述继续要求相应证据。第一方事实不得伪装成独立第三方证据。质量检查运行必须加载数据库中被 `generation_runs.prompt_version_id` 引用的已发布 Prompt 1.1.0（ID `25000000-0000-4000-8000-000000000006`），不得仅记录 Prompt ID 而执行静态旧提示词。

ADR-0015 后，`knowledge-worker` 是真实 BullMQ 消费进程，负责安全扫描、网页抓取或文件读取、解析、分块和向量化。内容生成必须按 `brief_sources` 限定资料范围，经过混合检索与重排后把命中片段传入 Content Writer，并把模型实际采用的引用写入 `ai_citations`。Compose 默认使用本地 1536 维 n-gram Embedding 与 Rerank；当前无生产 OCR Provider，因此界面只开放 PDF、DOCX、TXT。自动事实抽取、Fact Checker、GEO Optimizer、Publisher、Analytics CSV/Export 和 Lifecycle 的运行时缺口以 `docs/runbooks/RUNTIME_CAPABILITY_AUDIT_2026-07-19.md` 为准，不得宣称为已完成链路。

ADR-0025 后，只含官网的平台任务使用 `official-site-article-draft@1` 与 `official-site-faq-draft@1` 两个内部输出契约。母稿运行先保存官网正文，官网变体运行再生成 FAQ 并由服务端组装 slug、meta description、Schema.org 与引用映射。ADR-0027 增加 `official-site-article-expansion-draft@1`，仅在服务端计数确认正文不足时返回可追加的新段落或清单，最多两轮且不覆盖原文。事实证据分由声明和引用原文的支持关系决定，不按引用条数递增；敏感数字不一致时按不支持处理。该流程不新增公开端点、数据库表或配置项。

同一平台任何时刻最多只能有一个 `published` 规则版本。发布新规则必须在同一事务中将旧版本切换为 `retired`，数据库使用部分唯一索引兜底；审核快照只冻结该平台当前唯一生效的规则版本。

## 9. 页面与验收

冻结页面数：32。每页必须实现 loading/empty/error/permission/mobile/keyboard，筛选写入 URL。

| ID | 页面 | 权限 | 页面验收 |
|---|---|---|---|
| AUTH-01 | 登录 | public | 错误态不泄露邮箱是否存在；明确提示会话过期、退出和换号结果 |
| AUTH-02 | 租户选择 | authenticated | 禁用 membership 不可选择；可切换企业或换用其他账号 |
| DASH-01 | 工作台 | tenant_member | 筛选进入 URL；无权限卡片不展示 |
| STR-01 | 品牌策略列表 | tenant_member | 写操作仅 strategy_editor_or_admin |
| STR-02 | 品牌策略编辑 | strategy_editor_or_admin | 已发布版本只读 |
| STR-03 | 主题规划 | strategy_editor_or_admin | 无证据主题标记风险，不自动进入生产 |
| STR-04 | 关键词集 | strategy_editor_or_admin | 关键词集内规范化 term 唯一；搜索意图可复选并显示中文标签；关键词集列表完整分页且按数量自适应 |
| KNOW-01 | 资料列表 | tenant_member | 失效资料不进入新检索 |
| KNOW-02 | 上传资料 | strategy_or_content_editor_or_admin | 类型、大小、病毒扫描和 SSRF 校验 |
| KNOW-03 | 资料详情 | tenant_member | 原文和 chunk 可回溯 |
| KNOW-04 | 事实裁决 | reviewer_or_admin | 裁决写审计且不覆盖历史 |
| CONT-01 | Brief 列表 | tenant_member | 分页和筛选可复现 |
| CONT-02 | Brief 编辑 | strategy_or_content_editor_or_admin | 至少一平台、一关键词；事实型内容至少一来源 |
| CONT-03 | 内容包列表 | tenant_member | 包状态仅作摘要 |
| CONT-04 | 内容包详情 | tenant_member | 动作以变体状态守卫；生成、质量检查、审核顺序和进度对用户可见 |
| CONT-05 | 内容编辑器 | content_editor_or_admin | version 必填；冲突返回 409 |
| CONT-06 | 生成运行 | content_editor_or_admin | 取消恢复前一稳定状态 |
| QUAL-01 | 质量报告 | tenant_member | 无报告时可发起首次检查；block/revise 不可提交审核 |
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

原始开发任务固定 T001-T144，共 144 个；新增功能必须通过新 ADR、任务号和验收标准单独批准。T145 为已完成的百家号自动化，T146 为已完成的关键词多意图与自适应管理，T147 为已完成的关键词表格预检与异步分批导入，T148 为已批准的 DeepSeek 规划与 Cloudflare Workers AI 自动配图，T149 为已批准的官网媒体随文上传，T150 为已完成的搜狐号生成与托管浏览器发布，T151 为已完成的列举网分类信息生成与托管浏览器发布（真实发布灰度待单独授权），T152 为已完成的搜狐号与列举网临时凭据登录，T153 为已完成的搜狐号与列举网全链路自动化，T154 为已完成的列举网官方发布 API 接入。每任务包含交付物、文件范围、依赖、验收命令和统一 DoD。

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
| M8 | T145 | 百家号生成、质量门禁、排期与托管浏览器发布 |
| M9 | T148 | 官网与百家号质量通过后的自动配图、机器图像门禁与降级发布 |
| M10 | T149 | Windows 私有素材在官网发布时上传并转换为官网持久地址 |
| M11 | T150 | 搜狐号内容生成、扫码登录、托管浏览器发布和状态对账 |
| M12 | T151 | 列举网分类信息生成、QQ 扫码、托管浏览器发布和审核状态对账 |
| M13 | T152 | 搜狐密码与手机验证码、列举网密码登录及敏感输入不落库 |
| M14 | T153 | 搜狐号与列举网独立日批、冻结门禁重写、配图、排期和浏览器发布 |
| M15 | T154 | 列举网官方 API、GBK 表单、防重占位和人工确认 |

### 启动命令

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed:freeze-v21 # 仅本地演示环境可选
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
