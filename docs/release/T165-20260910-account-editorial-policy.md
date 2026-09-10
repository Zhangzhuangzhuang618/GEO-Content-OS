# T165 生产发布记录（2026-09-10）

## 发布结果

产品提交：`fd1334264d70ad1d84f018f6ea28314d91da9f3a`，分支 `feat/human-centered-ui-v1`。99个功能、测试和文档文件已提交并正常推送；用户未追踪脚本、outputs、deliverables、artifacts及本地验证脚本均未提交。

19:20（Asia/Shanghai）完成迁移和 API、Web、AI Worker、Publisher Worker 更新。四个容器的镜像 revision 均为该产品提交，16个GEO容器全部healthy，API readiness和Web首页均200，四个新容器重启次数0。未重建数据库、Redis、存储、浏览器或其他Worker。

- 迁移0060成功：61条迁移记录（0000–0060），94张版本管理业务表均存在。生产另有历史表 `publish_attempts_resolution_backup_20260805`，实际业务/历史表合计95；保留未动。
- 通过新版账号内容服务读取生产三平台5个账号：默认仍为standard、version 0；没有自动设置硬广名单、绑定资料或更改账号默认风格。
- 百家号通过既有 `BaijiahaoAutomationPolicyService.update` 更新两条策略并写入2条审计：启用策略version 5→6，停用策略10→11，source_mode均为independent；原日批开关、数量和时间保留。派生模式专用的independent_fallback_enabled改为false，以满足既有契约。停用账号没有启用，历史批次未重跑。
- 生产 `.env`、`.npmrc`、`CLAUDE.md`、根compose/package文件及两个运行override文件与备份SHA256一致；模型配置未改变，生产原有工作区改动未覆盖。
- 部署前无正在发布任务；9月2日遗留running及其他历史queued记录保留。测试文章没有发布至任何真实平台。

## 验收范围

最新真实隔离日批：`artifacts/t165-system-acceptance-2026-09-10T10-48-44-318Z/三平台日批验收.md`。
官网、列举网、抖音各3篇；11个候选中2个生成失败退出并补位，最终9个排程任务；重复调度幂等检查通过。96次模型调用，9篇正文、官网12项FAQ、抖音21张JPEG均完整自审，原文没有手工润色。

所有测试媒体为主动禁用外部生图后的模板降级。本次不验证Cloudflare额度、真实外部生图或对外发布成功率；9篇小样本也不代表未来首稿100%通过。同类主题仍有相似标题和预约措辞，不宣称达到所有参考样例表现力。

发布门禁所有组成项完成：初始完整release:check通过静态、功能旗标、OpenAPI、新数据库、AI eval、成本、安全和outbox chaos；无障碍沙箱权限失败后在沙箱外32页通过；负载fixture通过；本地恢复演练临时数据库启动失败后重跑通过；可观测性8项通过。系统E2E修复新表计数基线93→94并断言新表存在后2项通过。不声称某一次完整release:check命令退出0，不把本地负载/恢复演练当生产实测。

AI Worker 410项全量回归通过，Worker测试类型/生产构建、API类型、相关产品ESLint/格式和diff检查通过。生产四个镜像均从已提交的干净归档重新构建成功。

## 发布与回滚材料

- 干净源码：`D:\GEO-Content-OS-Releases\fd13342-20260910`。
- 备份：`D:\GEO-Backups\T165-20260910-fd13342`，ACL限定部署账户、Administrators和SYSTEM。
- PostgreSQL自定义格式备份 `database.dump`，pg_restore --list校验通过；SHA256：`3ec63ea35c26c8f5b5c7765eb1f0a2f6a8b65174b53b9f933bba299d323350dd`。没有执行生产数据库恢复演练。
- 原配置、原工作区diff和 `previous-images.json` 同目录保留。四个旧镜像增加 `rollback-t165-20260910` 标签；没有删除旧镜像。
- 实际运行compose顺序：新源码 `infra/compose.yaml` → 生产 `infra/compose.override.yaml` → `infra/compose.model-v41-preview.yaml` → 新源码 `infra/compose.t165-images.json`；使用生产 `.env` 和项目名geo-content-os。
- 如需要应用回滚，在同一compose参数后追加备份中的 `compose.rollback.json`，只对api/web/ai-worker/publisher-worker执行 `up -d --no-deps --no-build --wait`。迁移是增量兼容的，不自动删除新表或还原数据库。百家号配置恢复须单独经业务服务和审计，不盲目回放SQL。

## 部署中遇到的操作问题

服务器GitHub写入凭据不可用，本机正常push成功并以ls-remote核实远端SHA。传输到服务器的bundle经过SHA256及git bundle verify验证，再快进合并；不使用强推或覆盖工作区。

切换脚本以独立文件执行时首行未指定工作目录，重复HEAD核对报错；此前独立只读核对已确认精确SHA，四个镜像revision、活跃任务和API健康检查通过，迁移与切换随后成功。已归档补全Set-Location和错误中止设置的 `t165-switch-corrected.ps1`，未再次执行切换。该操作警告不隐去。

百家号切换第一次因Windows命令行长度限制未执行；改为SSH标准输入传送同一脚本后成功，经业务服务读取及审计数复核。未绕过权限或直接SQL修改策略。
