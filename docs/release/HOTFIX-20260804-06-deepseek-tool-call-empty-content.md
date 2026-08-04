# HOTFIX-20260804-06 DeepSeek 工具调用空正文误判

## 问题

百家号独立生文调用内容写作工具时，DeepSeek 首轮返回合法工具调用，但同时返回空白的 `assistant.content`。工具执行完成后的第二轮请求被本地适配器误判为非法空消息，任务以 `DEEPSEEK_INVALID_REQUEST` 立即失败。

## 修复

- assistant 消息携带至少一个工具调用时允许正文为空。
- 向 DeepSeek 发送历史工具调用消息时，将空白正文规范化为 `null`。
- assistant 既没有有效正文也没有工具调用时仍然拒绝；system、user、tool 空正文仍然拒绝。
- 增加适配器级回归测试，以及 Content Writer 经过真实 DeepSeek 适配器完成两轮工具调用的集成测试。

## 契约与部署

- 未修改冻结质量门槛、模型质量结论或业务重试次数。
- 未新增 API 或数据库迁移。
- 需要重新构建并部署 AI Worker；历史失败任务需在部署后重新生成或由新候选补位。
