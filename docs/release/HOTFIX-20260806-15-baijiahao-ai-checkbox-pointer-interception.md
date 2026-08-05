# HOTFIX-20260806-15 百家号 AI 声明点击拦截

## 真实页面证据

- HOTFIX-20260806-14 部署前真实验证在 `mark_ai_generated` 阶段阻断，尚未点击发布。
- 原生 `input[type="checkbox"]` 可见、启用，但普通 `setChecked(true)` 点击后仍为未选中。
- Playwright 诊断显示编辑器操作层会间歇拦截该控件区域的指针事件。
- 对同一个精确定位的原生 checkbox 使用强制点击后，`checked` 立即变为 `true`，组件类名同步出现 `cheetah-checkbox-checked`。

## 修复

- 保留必需控件和原生 checkbox 的精确定位。
- `setChecked(true)` 增加 `force: true`，绕过页面浮层的指针命中拦截。
- 点击后仍读取原生 `checked` 状态；未选中时继续在发布前阻断。

## 安全边界

- 不使用 DOM 属性伪造勾选状态，不跳过页面事件。
- 不放宽 AI 声明、正文、图片、质量或发布幂等门禁。
- 本次失败发生在点击发布前，未创建远端文章；再次执行前仍需查询全部作品状态。

## 部署与验收

- 重新构建并部署 Baijiahao Browser Worker；无需数据库迁移。
- 浏览器回归必须保持通过。
- 真实提交前截图必须显示 AI 声明已选中。
