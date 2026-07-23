# ADR-0021：官网机器质检、自动重写与自动发布闭环

## 状态

已接受。该变更仅适用于 `official_site`，是 v2.1 冻结基线后的明确业务变更；其他六个平台继续执行既有人工审核和发布流程。

## 背景

客户要求官网新闻优先保持更新活跃度：文章不经过人工审核，但不能绕过机器质量控制。质量不足时自动按问题重写，达到门禁后直接调用志远官网专用 API 发布；多次失败必须转人工，不能发布低质量内容。

## 决策

### 固定门禁

- GEO 总分至少 85；
- 事实准确性至少 90；
- 品牌一致性至少 90；
- 可读性与安全性至少 85；
- 问题覆盖度至少 80；
- 平台适配度至少 80；
- 存在任一 `BLOCK` 或 Quality Checker 决策不是 `pass` 时禁止发布；
- 官网标题必须为 20–60 个 Unicode 字符；
- 企业已发布品牌档案可作为第一方事实依据，不强制第三方 URL；
- 禁止编造价格、地址、电话、资质、客户数量、行业排名、第三方评价和结果承诺。

### 自动流程

1. 仅当项目启用了官网自动发布策略，且变体绑定启用中的官网 API 账号时，生成完成后自动创建质量检查；
2. 未通过时把门禁规则和 Quality Checker 问题清单交给 Content Writer，以质量模型重写完整文章；
3. 最多重写 3 次；仍未通过或重写执行连续失败 3 次，进入 `manual_required`；
4. 通过后跳过人工审核，以当前不可变 `content_version_id` 创建自动发布任务；
5. Publisher Worker 使用同一幂等键最多调用官网 3 次；成功记录官网文章 ID、URL 和发布时间；
6. 失败任务保留人工重试与取消入口，但总发布尝试数仍不得超过 3；
7. 用户编辑 `manual_required` 内容后重新检查质量时，自动流程改绑最新内容版本并从 0 次重写重新开始。

### 幂等与安全

- 发布幂等键固定为 `official-site:<variant_id>:<content_version_id>`；
- 官网端以幂等键和 `content_version_id` 双重唯一约束阻止重复文章；
- 账号凭证只保存官网 API `base_url` 和 Bearer Token 的加密信封，API/UI/日志不得回显；
- 官网 API 的完整路径前缀属于 `base_url`；远程地址必须使用 HTTPS，仅本机 loopback 联调允许 HTTP；
- 不模拟浏览器登录，不调用官网后台表单；
- 不反向同步官网后台人工删除，这是第一期明确限制；
- 生产域名和生产令牌不得用于本地或 CI 验收。

## 数据与接口影响

- 新增 `official_site_automation_policies`、`official_site_automation_runs`；
- `quality_reports` 新增 `automation_gate_json`；
- `publish_jobs` 新增不可变 `origin` 和 `published_at`；
- 新增 GET/PUT `/platform-accounts/{id}/official-site-automation`；
- 新增事件 `content.variant.official_site_rewrite_requested.v1`；
- 迁移增至 0037，当前表数 59，公开 API 数 127。

## 运维

Publisher Worker 是必需服务。关闭自动发布策略只影响后续生成，不删除历史运行、质量报告、发布任务或官网文章。故障和回滚步骤见 `docs/runbooks/OFFICIAL_SITE_AUTOMATION.md`。
