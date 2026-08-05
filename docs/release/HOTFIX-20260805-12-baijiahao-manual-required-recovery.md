# HOTFIX-20260805-12 百家号需人工发布状态恢复

## 生产证据

- 百家号发布任务最新尝试为 `failed / MANUAL_REQUIRED`，任务、内容版本和内容包均进入发布失败状态。
- 浏览器发布记录、百家号自动化运行和每日批次项同时停在 `manual_required`。
- 普通重试只接受自动化运行处于 `publish_failed`，因此三次请求均返回
  `Baijiahao automation run is inconsistent`，事务全部回滚且没有新增发布尝试。
- 账号和浏览器会话均为正常登录状态，409 与登录态无关。

## 修复

- 最新尝试为 `unknown`，或为 `failed / MANUAL_REQUIRED` 时，统一进入百家号人工核实入口。
- 这两类状态均禁止普通重试，避免在远端结果未核实前重复发布。
- 人工确认未发布后，在同一事务中：
  - 将浏览器发布记录由 `manual_required` 等不确定状态恢复为 `prepared`；
  - 将百家号自动化运行由 `manual_required` 恢复为 `scheduled`；
  - 将每日批次项恢复为 `scheduled` 并清除旧错误；
  - 使用原内容版本、载荷哈希和幂等键排队重试。
- 人工确认已经发布时继续使用现有公开链接登记流程。
- 所有历史发布尝试保持追加写，不修改或删除原 `unknown`、`failed` 记录。

## 冻结边界与部署

- 不修改质量门槛、自动重写次数、发布尝试上限或模型结论。
- 不自动判定百家号是否已经发布，必须由用户在百家号内容管理中核实。
- 无数据库迁移，不操作生产数据。
- 需要重新构建并部署 API、Web；Publisher Worker、Baijiahao Browser 和 AI Worker 无需因本 Hotfix 重建。

## 验证

- API 单元和模拟接口测试覆盖 `MANUAL_REQUIRED` 的恢复路径。
- 真实 PostgreSQL 集成测试复现任务、浏览器发布记录、自动化运行和每日批次项四层状态，验证普通重试被阻断、人工核实后原子恢复，且历史尝试不变。
- 发布详情 Playwright 覆盖 `MANUAL_REQUIRED` 的人工核实入口和请求参数。
- API、Web 类型检查、Web 生产构建和相关代码检查通过。
