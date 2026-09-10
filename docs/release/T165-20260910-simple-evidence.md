# T165 资料配置简化：生产发布记录

## 产品与验证

产品提交 `e5f89953fc929cf4e955fc639001205a350b1c94`，分支 `feat/human-centered-ui-v1`。31个产品、测试及文档变更；用户未追踪文件、脚本和验收产物未提交。GitHub直连HTTP/2错误及HTTP/1.1超时后，经临时SSH网络隧道向原仓库正常推送，远端精确SHA一致。服务器校验bundle SHA256并快进合并，保留服务器原有工作区改动。

验证通过：Contracts 192、AI Worker 411、API单元286、相关数据库集成24、Publisher集成40、账号页面交互28项。API/Web生产构建、AI测试类型、根类型、OpenAPI/SDK校验、相关ESLint/格式/diff及静态发布门禁通过；公开端点仍172，数据库仍61项迁移/94张版本管理业务表，本轮没有迁移。

真实隔离日批15-15轮：官网、列举网、抖音各3篇，11候选中2篇被内容门禁拒绝并自动补齐，最终9份通过质检、9个排程任务；82次模型调用。9篇正文/官网FAQ及21张抖音JPEG已完整自审，原文未手动润色。验收入口：`artifacts/t165-system-acceptance-2026-09-10T15-15-24-558Z/9篇原文与验收结果.md`。

此轮模板媒体和隔离向量fixture不验证真实外部生图、生产全量召回或实际发布。补充生产等价资料试跑在调用模型前遇到测试容器端口启动超时；重试被安全审核拦截，证照文字外发授权未获识别，未绕过，不记为通过。发布采用上述已经完成的日批与回归，并另行只读核对实际生产资料解析/归属，不发送新的模型请求。

## 备份与发布状态

部署前备份 `D:\GEO-Backups\T165-simple-20260910`，ACL限部署用户、Administrators、SYSTEM。数据库自定义格式备份经pg_restore --list校验，SHA256：`56DB4AFB033F3426763138C7B47BB5C2D7D40F98A9E7DC1CB9A71ADE21F12608`。保留配置、工作区patch、previous-images.json和四个 `rollback-t165-simple-20260910` 旧镜像标签。

2026-09-10 23:59（Asia/Shanghai）完成部署和配置：API/Web/AI/Publisher四个镜像revision均为e5f8995，重启计数均0；16个GEO容器全部healthy，API readiness与首页均200。生产.env、.npmrc、CLAUDE、根compose/package和两个运行override文件与备份SHA256一致。四份经营者确认服务说明经SourceService入库并由生产Knowledge Worker解析为active，未覆盖旧资料。新镜像只读核验10账号均通过；主公司资料在众人工作区解析为11份、志远工作区4份，另一搬家公司继承资料均不含证照。

首次干净构建在pnpm下载797/798后长时间没有进度。重新从fd13342干净归档命中原依赖/构建缓存，导出build阶段作为依赖缓存（`sha256:24caf4c4962a5c49ed41745d760ee6a61296f8b914bcf1835fffd897621d55e6`）；确认fd13342到e5f8995无删除文件后覆盖本次干净源码，执行`pnpm install --offline --frozen-lockfile`并重新编译。仅停止本次卡住的docker build进程，没有停止生产容器；原Dockerfile未修改，四份临时cached Dockerfile保留在备份目录。缓存不作为跳过编译或锁文件检查的理由。

已通过业务服务及原版本号更新：众人与志远各自官网、列举网和企业介绍口吻抖音共6账号启用硬广；师傅/客户抖音共4账号恢复standard。十个账号均配置主公司、另一搬家公司、盛源，常规账号保留可手动选择的硬广预设，但默认和日批仍为standard。主公司自动有效资料，另一搬家公司明确沿用服务，盛源使用业务说明；证照只归持证主体。默认和日批覆盖逐项一致，原口吻、定位、范围、地区、主题池、数量、排程、启停逐项深比较不变。没有重跑历史任务或发布测试文章。

审计核对：`t165-simple-20260910-config`对应10条account.content_policy.updated、8条browser_platform.automation.updated、2条official_site.automation_policy.updated；最后配置写入于23:59:14，早于次日00:00官网日批窗口。

运行compose顺序：`D:\GEO-Content-OS-Releases\e5f8995-20260910\infra\compose.yaml` → 生产`infra\compose.override.yaml` → 生产`infra\compose.model-v41-preview.yaml` → 新发布目录`infra\compose.t165-images.json`；仍使用生产.env和geo-content-os项目名。切换前publishing/generating均0（排除9月2日已知遗留running记录，未修改）。脚本文件首次被Windows默认执行策略拒绝，当时没有停止服务；随后仅对本次PowerShell进程使用ExecutionPolicy Bypass，系统执行策略未修改，健康回滚门禁完整执行。

切配置前的镜像健康失败可直接用备份中的compose.rollback.json恢复四个旧镜像。切配置之后回滚必须先用业务服务恢复账号/日批设置（审计及备份保留旧值），再回滚镜像；旧版不理解新配置字段，不可只换回镜像。不得为回滚本功能直接还原整库、覆盖后续业务数据。
