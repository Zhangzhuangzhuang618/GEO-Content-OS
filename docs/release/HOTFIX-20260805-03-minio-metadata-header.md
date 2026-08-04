# HOTFIX-20260805-03 MinIO 配图元数据 Header 兼容

## 问题

生成配图写入 MinIO 时，对象元数据 `ai_disclosure` 使用中文值 `AI示意图`。S3 兼容存储会将用户元数据序列化为 `x-amz-meta-*` HTTP Header，Node.js 因 Header 包含非 ASCII 字符而在请求发送前失败。

## 修复

- 对象存储元数据改用 ASCII 值 `ai_generated`。
- 数据库 `media_assets.metadata_json.ai_disclosure` 继续保存中文展示值 `AI示意图`，不改变业务展示与披露语义。
- 存储适配器在发出请求前校验元数据值只包含可见 ASCII 字符，使同类配置错误返回明确的适配器校验错误。

## 冻结契约

- 不改变图片生成、检查、回退和发布门槛。
- 不改变数据库中的 AI 配图披露文案。
- 不改变 MinIO/S3 对象路径及公开 URL 规则。

## 验证

- 存储适配器：2 个测试文件、10 项测试全部通过，覆盖中文元数据拒绝与 ASCII 元数据成功写入。
- AI Worker：16 个测试文件、97 项测试全部通过。
- 全仓 TypeScript 类型检查通过。
- 全仓 ESLint 检查通过（排除用户现有未跟踪文件 `build_keywords.mjs`）。
- 本 Hotfix 相关文件 Prettier 检查通过。
