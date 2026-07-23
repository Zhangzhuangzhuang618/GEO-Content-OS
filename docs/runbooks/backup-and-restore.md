# PostgreSQL 备份、连续 WAL 与恢复演练

适用范围：GEO Content OS PostgreSQL 16。目标是每日一次全量物理备份、连续 WAL 归档、RPO 不超过 15 分钟、RTO 不超过 60 分钟。本文不授权生产操作；生产恢复必须走事故指挥和变更审批。

## 1. 不变量

- PGDATA、基础备份和 WAL 归档必须位于相互独立的持久存储；同盘副本不算备份。
- 备份介质必须启用服务端加密、最小权限、版本控制和不可变保留策略；凭证仅从密钥服务或运行环境注入。
- 每日基础备份必须通过 `pg_verifybackup`。失败或未校验的备份不得进入可恢复清单。
- WAL 归档失败、最近成功归档超过 10 分钟、基础备份超过 26 小时均告警；超过 15 分钟视为 RPO 违约。
- 每月至少执行一次隔离恢复演练并保存机器可读证据；季度演练包含应用只读验证。

## 2. PostgreSQL 配置

将 `infra/backup/postgresql-wal.conf` 作为 PostgreSQL 配置片段加载，并把 `/var/lib/postgresql/wal-archive` 挂载到独立耐久存储。配置使用 5 分钟 `archive_timeout`，为 15 分钟 RPO 留出监控和传输余量。

启用后验证：

```text
SHOW wal_level;       -- replica
SHOW archive_mode;    -- on
SHOW archive_timeout; -- 5min
SELECT archived_count, failed_count, last_archived_time FROM pg_stat_archiver;
```

托管 PostgreSQL 应使用供应商的连续归档/PITR 能力实现同等配置，不复制本地文件型 `archive_command`。必须记录供应商实际保留期、最近可恢复时间和跨区域策略。

## 3. 每日基础备份

备份进程以 PostgreSQL 专用账号运行，账号仅授予 replication 和连接能力。运行前通过环境提供 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`，并设置：

```text
BACKUP_ROOT=/durable/postgres/base-backups
BACKUP_ID=YYYYMMDDTHHMMSSZ
infra/backup/create-base-backup.sh
```

脚本拒绝覆盖已有目录，使用 `pg_basebackup` 流式包含 WAL，并在成功后执行 `pg_verifybackup`。调度器只有看到 `BACKUP_VERIFIED=true` 才能登记成功。建议保留 35 天每日备份、12 个月月末备份；若法规或合同另有要求，以更严格者为准。

## 4. 恢复流程

1. 事故指挥确认恢复范围、目标时间和数据影响，停止写流量并保存当前故障现场。
2. 选择目标时间之前最近且校验成功的基础备份，确认从该备份起到目标时间的 WAL 连续完整。
3. 在隔离主机准备全新的空目录；禁止对原 PGDATA 原地恢复。
4. 以 PostgreSQL 运行账号设置 `BACKUP_DIR`、`RESTORE_DATA_DIR`、`WAL_ARCHIVE_DIR`。时间点恢复另设 ISO 8601 格式的 `RECOVERY_TARGET_TIME`。
5. 运行 `infra/backup/prepare-restore.sh`。脚本再次校验 manifest、复制基础备份、配置 `restore_command` 并创建 `recovery.signal`。
6. 启动 PostgreSQL，监控日志直至达到恢复目标并提升。执行数据库校验、迁移版本校验、核心表计数和应用只读烟测。
7. 记录实际 RPO、RTO、恢复目标、备份 ID、最后 WAL、审批人和校验结果。未经批准不得切换生产流量。

若 manifest 校验失败、WAL 不连续、恢复目标超出可恢复窗口或校验结果不一致，立即停止，不得跳过校验强行提升。

## 5. 自动化恢复演练

在本地或 CI 的隔离 Docker 环境运行：

```text
pnpm verify:restore
```

该命令创建临时 PostgreSQL 16 实例，完成以下真实操作：写入基线数据、生成并校验基础备份、写入备份后事务、强制归档 WAL、关闭源实例、从基础备份与 WAL 恢复到新实例、验证两笔事务并清理临时容器和卷。

命令向标准输出写出符合 `infra/backup/restore-evidence.schema.json` 的证据。若需保存 CI artifact，设置 `RESTORE_EVIDENCE_PATH` 为工作区外的安全路径。证据中的 `configured_rpo_bound_seconds` 必须不大于 900，`observed_data_loss_seconds` 必须不大于 900，`rto_seconds` 必须不大于 3600，且所有检查均为 true。

本地演练证明脚本和恢复链路可执行，不等于生产 RPO/RTO 已达标。生产达标证据必须来自生产同构环境的定期演练和监控记录。

## 6. 失败处置与证据保留

- 备份失败：保留错误日志，修复后创建新 `BACKUP_ID`，不得覆盖失败目录。
- WAL 归档失败：立即告警，检查容量、权限和网络；在归档恢复前不得声称满足 RPO。
- 恢复超时：记录耗时分段，优先处理介质吞吐、WAL 数量和启动检查，不降低数据校验。
- 演练证据至少保存 12 个月，访问权限限平台运维和审计人员；日志不得包含数据库口令、连接串或租户内容。
