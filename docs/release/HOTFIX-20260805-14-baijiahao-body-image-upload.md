# HOTFIX-20260805-14 百家号正文配图上传

## 生产证据

- 百家号发布在 `upload_body_images` 阶段返回 `PAGE_SIGNATURE_CHANGED`。
- 当前百家号编辑器没有常驻的正文图片 `input[type=file]`，页面常驻文件控件只有视频上传。
- 正文工具栏图片按钮的稳定属性为 `data-function="insertimage"`；点击后浏览器使用瞬时
  文件选择器，取消选择后不会在 DOM 中保留图片输入框。
- 封面上传已先于该阶段执行，失败与封面区域无关。

## 修复

- 保留既有常驻正文图片输入框路径，兼容本地仿真和旧页面结构。
- 常驻输入框不存在时，点击 `[data-function="insertimage"]` 并监听 Playwright
  `filechooser` 事件，不依赖瞬时文件输入框的 DOM。
- 根据文件选择器是否支持多选决定批量或逐张上传；每批上传后等待图片实际插入正文 iframe，
  再继续后续发布字段和提交操作。
- 图片入口本身不存在时继续进入 `PAGE_SIGNATURE_CHANGED / MANUAL_REQUIRED`，不静默跳过配图。

## 边界与部署

- 不修改封面上传、内容正文、发布状态机、尝试上限、质量门槛或登录判断。
- 不绕过验证码、风控或平台审核，不把浏览器提交视为发布成功。
- 无公开 API 或数据库变更。
- 仅需重新构建并部署 Baijiahao Browser Worker。

## 验证

- 本地浏览器仿真页面使用与生产一致的 `data-function="insertimage"` 瞬时文件选择器路径，
  验证封面和正文图片均上传后才提交。
- 执行 Baijiahao Browser 单元测试、浏览器集成测试、类型检查、构建和相关代码检查。
