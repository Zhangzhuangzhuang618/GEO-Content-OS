# HOTFIX-20260805-04 配图规划与字体运行环境修复

## 生产结论

- 最近配图运行均为 `plan_source=template`、`external_calls=0`，Cloudflare 没有收到生图请求。
- 图片规划器向 DeepSeek 请求 `json_schema` 响应格式，但当前 DeepSeek 适配器明确不支持该能力，请求在本地校验阶段即失败。
- 规划异常此前被静默回退，运行记录和日志均没有保留底层原因。
- AI Worker 运行镜像缺少 Fontconfig 配置与中文字体，日志出现 `Cannot load default config file`。

## 修复

- 图片规划请求改用 DeepSeek 支持的 `json_object`，模型返回后继续执行现有的本地结构、长度、品牌与敏感内容校验。
- 模型或本地校验失败时仍使用安全模板回退，但将脱敏后的 `planner_failure` 写入配图运行诊断并输出结构化错误日志。
- AI Worker 运行镜像安装 Fontconfig 与 Noto CJK 字体并重建字体缓存。

## 冻结边界

- 不降低配图提示词的品牌、联系方式、二维码、价格和证据冒充拦截规则。
- 不伪造模型规划结论；规划失败仍明确标记为模板回退。
- 不改变 Cloudflare 驱动、MinIO 路径、公开 URL 或发布门槛。

## 部署后核验

1. 重建并更新 AI Worker。
2. 对一篇合格内容重新触发配图；历史回退记录不会自动重跑。
3. 确认新运行的 `plan_source=deepseek` 且 `external_calls` 大于零。
4. 如仍回退，检索 `Article image planning failed; using template fallback`，并查看 `diagnostics_json.planner_failure`。
5. 确认日志不再出现 Fontconfig 配置缺失。

## 验证

- AI Worker：16 个测试文件、98 项测试全部通过。
- 全仓 TypeScript 类型检查通过。
- 全仓 ESLint 检查通过（排除用户现有未跟踪文件 `build_keywords.mjs`）。
- 本 Hotfix 相关文件 Prettier 检查通过。
