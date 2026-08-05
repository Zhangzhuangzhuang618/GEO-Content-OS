# HOTFIX-20260806-16 百家号受控 AI 复选框

## 真实页面证据

- HOTFIX-20260806-15 后的真实验证仍在 `mark_ai_generated` 阶段阻断，未点击发布。
- Playwright 日志确认 `setChecked(true, { force: true })` 已对目标原生 checkbox 执行点击，但百家号受控组件没有保留该状态。
- 独立真实页面诊断使用同一定位器执行 `click({ force: true })` 后，原生 `checked` 为 `true`，组件类名同步出现 `cheetah-checkbox-checked`，等待后状态未回滚。

## 修复

- 已选中时不重复操作。
- 未选中时使用经真实页面验证的 `click({ force: true })`，让百家号组件自身处理点击事件。
- 点击后继续读取原生 `checked`；未选中时仍在发布前阻断。

## 安全边界

- 不直接写 DOM 属性，不伪造 React/组件状态。
- 不跳过 AI 声明，不放宽正文、图片、质量、幂等或未知态门禁。
- 本次真实验证未到达发布点击，远端未创建目标文章。

## 部署与验收

- 重新构建并部署 Baijiahao Browser Worker；无需数据库迁移。
- 浏览器回归必须保持通过。
- 再次真实提交前必须先搜索全部作品状态；发布前截图必须显示 AI 声明已选中。
