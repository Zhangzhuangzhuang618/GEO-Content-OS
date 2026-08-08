# HOTFIX-20260808-01 百家号终态对账恢复

## 生产证据

- `日志 (1).txt` 中发布任务 `96c9d229-2c4a-4262-81b9-3ca6be02d73a` 的百家号文章实际发布成功，外部文章 ID 为 `1872934608584882031`。
- Baijiahao Browser Worker 已把浏览器发布记录写成 `published`；Publisher Worker 随后仍只允许从 `submitting`、`unknown` 或 `processing` 更新该记录。
- Publisher Worker 因更新行数为零抛出 `Publish job state is invalid`，同一事务中的发布任务、自动化运行和每日批次收尾全部回滚；BullMQ 五次重试均复现相同结果。
- 现有系统没有仅重新投递百家号对账的公开管理接口或页面操作；原有“重试发布”会重新进入发布执行链路，不能用于这类已生成外部文章 ID 的历史任务。

## 根因

- Browser Worker 状态接口与 Publisher Worker 分别拥有独立事务，前者可能先提交浏览器发布终态。
- Publisher Worker 把“浏览器发布记录仍是非终态”误当成完成整条业务事务的必要条件，未把相同外部文章 ID 的相同终态视为幂等结果。
- 这是确定性的跨服务终态写入冲突，不是平台假失败，也不是偶发网络超时。

## 修复

- Publisher Worker 对浏览器发布记录增加外部文章 ID 精确匹配。
- 远端核验为 `published` 时，允许浏览器记录已是同一 `published` 终态；远端核验为 `failed` 时，允许记录已是同一 `failed` 终态。处理中和未知态仍不得覆盖终态。
- 新增 `POST /publish-jobs/{id}/reconcile` 管理接口和 PUB-03“重新核验百家号状态”操作。
- 管理操作只提升发布任务版本并投递 `baijiahao.publication.reconcile_requested.v1`，不投递发布执行事件，不重新打开编辑器或点击发布。
- 任务详情仅在浏览器记录已经是 `published` 或 `failed`、外部文章 ID 精确一致且任务仍为 `publishing` 时显示该操作。

## 安全边界

- 仅支持 API 模式的百家号任务；其他平台、非发布中任务、非当前内容版本、账号不可用、浏览器记录非唯一或外部文章 ID 不一致时全部拒绝。
- 不降低质量门禁，不重新评估旧质量报告，不伪造平台或模型结论。
- 不自动扫描或批量修改历史任务；每条历史任务必须在详情页显式重新投递对账。
- 本 Hotfix 未操作生产数据库、生产官网或百家号生产内容。

## 部署与历史任务收尾

- 重新构建并部署 API、Web 和 Publisher Worker；无需数据库迁移，Baijiahao Browser Worker 无需因本 Hotfix 重建。
- 部署后打开发布任务 `96c9d229-2c4a-4262-81b9-3ca6be02d73a` 的详情页，点击“重新核验百家号状态”。
- 预期结果是只产生新的百家号对账事件，随后任务、自动化运行和每日批次按现有核验结果完成收尾；不得产生新的发布执行事件。

## 验证

- 契约与 OpenAPI 校验通过：146 个公开业务操作。
- API 契约、Mock E2E 和发布任务集成测试通过。
- Publisher Worker 单元测试通过；Docker 集成测试 11/11 通过，覆盖浏览器记录先写 `published` 和先写 `failed` 两种终态。
- Web 类型检查和生产构建通过；PUB-03 Playwright 回归 11/11 通过，并验证管理操作只请求对账接口。
