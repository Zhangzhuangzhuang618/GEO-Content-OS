# 平台发布灰度旗标

`platform-rollout.v1.json` 是 v2.1 发布灰度的机器可读配置，初始状态为全部关闭。它不包含密钥、租户白名单，也不会自行连接任何真实平台。

固定顺序：

1. Phase 1：`official_site`、`zhihu`、`xiaohongshu`。
2. Phase 2：`baijiahao`、`toutiao`、`wechat_mp`、`douyin`，且必须在 Phase 1 门禁持续达标后才可开启。

部署系统必须同时支持全局 `GEO_PUBLISHING_KILL_SWITCH=true` 和逐平台环境变量。全局开关优先级最高，任一配置缺失均按关闭处理。变更旗标前后都必须执行 `pnpm release:check`；生产变更仍需独立审批，本仓库任务不授权生产部署或真实平台发布。

运行 `pnpm feature-flags:check` 可验证七平台覆盖、阶段顺序、冻结阈值和 fail-closed 初始状态。
