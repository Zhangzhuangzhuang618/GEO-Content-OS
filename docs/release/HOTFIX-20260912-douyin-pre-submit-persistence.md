# 抖音提交前持久化异常恢复

范围：截图落库前失败不暂停整个账号；脱敏记录底层异常链。

- 先保存提交前截图，再写入 submitting / submitted_at，随后才点击发布。截图上传或索引失败时保持 prepared，返回503供已有重试链路处理，不假装提交成功。
- 历史 EDITOR_OPERATION_FAILED + persist_pre_submit 的账号允许重新核验真实登录态；验证码、页面校验及 submit 阶段异常不在恢复范围。历史 manual_required 发布记录仍需显式核实处理，不自动重置。
- safeBrowserError记录最多四层错误链并限制总长度，沿用凭证脱敏；HTTP响应不返回原始底层错误。
- 生产本次仅重试用户指定的9月12日08:20、08:40两任务；昨晚两任务保持原状。

验证：61项单元测试、类型检查、相关ESLint通过，覆盖截图上传/索引失败不标记提交、不锁账号，旧安全异常恢复、非安全阶段不恢复及嵌套错误脱敏。

## 生产验证（2026-09-12）

- 本地23项Chromium集成测试通过；首次因受限环境无法启动浏览器失败，获准沙箱外重跑通过。
- 生产浏览器镜像 `geo-content-os/douyin-browser:persist-a5d57ca`，产品提交`a5d57ca`；原浏览器保留`rollback-persist-0912`。复用已核对的Playwright运行环境，编译覆盖新工作区。无数据库迁移。
- 发布目录`D:\GEO-Content-OS-Releases\douyin-persist-a5d57ca`；当前Compose镜像覆盖文件在regional-0912-4f353fb发布目录中增加douyin-browser项，其他服务镜像及环境配置不变，原覆盖文件保留`.before-douyin-persist`副本。
- 16个GEO容器healthy，API200，Docker剩余约52GiB。
- 两账号真实会话核验均authenticated；临时对象写入、读回、删除通过。
- 通过既有`resolveUnknownInTransaction`和审计恢复今天两个任务（`9d1aede1-82d3-4bc1-9899-f1d147109d0d`、`61f1af60-4055-48fd-b8e6-dde48f33e8b2`），事务前核对没有浏览器发布记录或外部引用。没有直接改写成功状态。
- 09:54两个任务均完成实际提交并各保存pre_submit/post_submit截图，进入processing，待平台结果查询。昨晚两条失败任务不改动。
