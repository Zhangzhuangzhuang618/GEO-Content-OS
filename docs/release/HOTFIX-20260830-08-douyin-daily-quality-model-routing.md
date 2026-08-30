# HOTFIX-20260830-08 抖音日批质量模型路由修复

## 生产证据

2026-08-30 的两个抖音日批共尝试 18 个候选，最终均为 `attention_required`，没有候选进入质检、配图或发布：

- 11 个候选因 `SKILL_OUTPUT_INVALID` 退出，其中 10 次为修复后仍只有 133–135 字符的无效 JSON，1 次为 `platform_meta` 不符合输出 Schema；
- 7 个候选由既有抖音确定性质量门禁正常淘汰；
- 18 个生成事件均由 Outbox 首次投递成功，AI Worker、Outbox、Publisher 与抖音 Worker 均健康。

生产 `CONTENT_MODEL_QUALITY_KEY` 和 `QUALITY_CHECKER_MODEL_KEY` 均被配置为 `deepseek-v4-flash`，与 Fast、Balanced 路由相同。该配置违反 ADR-0011 的模型路由：Fast/Balanced 使用 Flash，Quality 使用 Pro。抖音日批直接使用 Quality 模型生成，因此整批实际由 Flash 执行，且无法获得不同质量模型的结构化输出兜底。

## 修复

1. DeepSeek 驱动启动时拒绝把内容质量模型或 Quality Checker 模型配置为与 Fast/Balanced 相同的模型键，避免质量路由静默退化。
2. AI Worker 启动日志仅记录四个非敏感模型键，便于部署后核验路由；不记录 API Key、Prompt、内容或模型原始响应。
3. 生产恢复：
   - `CONTENT_MODEL_QUALITY_KEY=deepseek-v4-pro`
   - `QUALITY_CHECKER_MODEL_KEY=deepseek-v4-pro`
4. 部署前使用生产现有 DeepSeek 连接做最小能力探测，确认 `deepseek-v4-pro` 返回 HTTP 200 且 JSON Mode 可用。

不修改数据库、公开 API、候选上限、质量分数、确定性门禁或发布规则。历史失败批次不自动改写；部署后由发布管理员显式重新发起日批。
