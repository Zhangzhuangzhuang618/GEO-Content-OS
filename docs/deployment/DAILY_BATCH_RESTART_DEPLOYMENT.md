# “重新发起今日批次”功能部署说明

适用范围：GEO Content OS 的官网每日十篇功能。

本次升级增加：

- 正式的“重新发起今日批次”页面入口；
- 同日多次批次尝试和历史记录保留；
- 批次版本校验、幂等、权限校验与审计；
- 数据库迁移 `0040_official_site_daily_batch_attempts`；
- 新增公开 API：
  `POST /api/v1/platform-accounts/{id}/official-site-automation/daily-batch/restart`。

## 1. 升级影响

必须重新构建并启动：

| 服务 | 原因 |
|---|---|
| `migrate` | 执行数据库迁移 0040 |
| `api` | 提供重发 API、批次状态和权限校验 |
| `web` | 提供按钮、确认提示和新批次进度 |
| `ai-worker` | 识别同日多次尝试并继续生成 |

`migrate` 与 `api` 使用同一个 `geo-content-os/api:dev` 镜像，因此执行 `build api` 已同时更新迁移程序。

本次不需要重新构建：

- `publisher-worker`
- `outbox-relay`
- `knowledge-worker`
- `postgres`
- `redis`
- `minio`

本次没有新增环境变量，也不要修改已有的 DeepSeek Key 或平台凭证加密密钥。

重要：迁移 0040 会调整每日批次唯一约束。迁移后不能继续运行旧版 `ai-worker`，否则旧代码的
`ON CONFLICT` 目标与新约束不匹配，会持续报 SQL 错误。

## 2. 部署前检查

以下命令以 Windows PowerShell、项目目录 `D:\GEO-Content-OS` 为例。若实际目录不同，请先进入实际目录。

```powershell
Set-Location D:\GEO-Content-OS
git status --short --branch
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml ps
```

要求：

1. Git 工作区没有未提交修改；
2. `.env` 存在且仍包含原有生产配置；
3. `postgres` 状态正常；
4. Docker Desktop 或 Docker Engine 正常运行；
5. 磁盘空间足够保存数据库备份和新镜像。

如果 `git status` 显示本地修改，先人工确认，不要直接执行 `git reset --hard`。

## 3. 备份

### 3.1 备份 `.env`

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force .\backup | Out-Null
Copy-Item .\.env ".\backup\.env-$stamp"
```

### 3.2 备份 PostgreSQL

```powershell
$postgresContainer = docker compose `
  --env-file .env `
  -p geo-content-os `
  -f infra\compose.yaml `
  ps -q postgres

docker exec $postgresContainer sh -lc `
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/geo-before-0040.dump'

docker cp `
  "${postgresContainer}:/tmp/geo-before-0040.dump" `
  ".\backup\geo-before-0040-$stamp.dump"

docker exec $postgresContainer rm -f /tmp/geo-before-0040.dump
```

确认备份文件存在且大小不为 0：

```powershell
Get-Item ".\backup\geo-before-0040-$stamp.dump"
```

## 4. 拉取代码

如果服务器直接部署当前功能分支：

```powershell
git fetch origin
git switch feat/human-centered-ui-v1
git pull --ff-only origin feat/human-centered-ui-v1
git log -1 --oneline
```

如果代码已经合并到 `main`，改为：

```powershell
git fetch origin
git switch main
git pull --ff-only origin main
git log -1 --oneline
```

部署前确认最新提交包含：

- `apps/api/src/database/migrations/0040_official_site_daily_batch_attempts.sql`
- `docs/adr/ADR-0024-official-site-daily-batch-restart.md`

## 5. 构建新镜像

构建过程可以在旧服务仍运行时完成：

```powershell
docker compose `
  --env-file .env `
  -p geo-content-os `
  -f infra\compose.yaml `
  build api web ai-worker
```

构建失败时不要执行迁移。先解决构建错误，并确认三个镜像都构建成功。

## 6. 停止受影响服务

迁移前停止旧版 API、Web 和 AI Worker：

```powershell
docker compose `
  --env-file .env `
  -p geo-content-os `
  -f infra\compose.yaml `
  stop web api ai-worker
```

不要停止或删除 PostgreSQL 数据卷。禁止执行：

```powershell
docker compose down -v
```

## 7. 执行迁移 0040

```powershell
docker compose `
  --env-file .env `
  -p geo-content-os `
  -f infra\compose.yaml `
  run --rm migrate
```

迁移必须以退出码 0 结束。出现错误时不要启动旧版 `ai-worker`。

检查新字段和约束：

```powershell
docker compose `
  --env-file .env `
  -p geo-content-os `
  -f infra\compose.yaml `
  exec -T postgres sh -lc `
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_name = ''official_site_daily_batches''
      AND column_name = ''attempt_no'';
  "'
```

预期能看到 `attempt_no`，数据类型为 `smallint`，默认值为 `1`。

## 8. 启动新服务

```powershell
docker compose `
  --env-file .env `
  -p geo-content-os `
  -f infra\compose.yaml `
  up -d --no-build --force-recreate api web ai-worker
```

查看状态：

```powershell
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml ps
```

预期：

- `api` 为 healthy；
- `web` 为 healthy；
- `ai-worker` 为 healthy；
- `migrate` 已成功退出；
- `postgres`、`redis`、`minio` 保持正常。

## 9. 日志检查

```powershell
docker compose `
  --env-file .env `
  -p geo-content-os `
  -f infra\compose.yaml `
  logs --tail 200 api web ai-worker
```

重点确认没有：

- migration failed；
- relation/column does not exist；
- no unique or exclusion constraint matching the ON CONFLICT specification；
- API Schema validation failed；
- AI Worker 持续重启。

实时观察：

```powershell
docker compose `
  --env-file .env `
  -p geo-content-os `
  -f infra\compose.yaml `
  logs -f --tail 100 api ai-worker
```

按 `Ctrl+C` 只会退出日志跟随，不会停止容器。

## 10. 页面验收

1. 登录 GEO Content OS；
2. 进入“发布管理”；
3. 切换到“平台账号”；
4. 找到官网账号并进入“官网自动发布”；
5. 选择已经开启每日十篇计划的项目；
6. 找到“今日发布进度”。

只有同时满足以下条件时才显示“重新发起今日批次”：

- 是当天批次；
- 状态为“需要人工处理”；
- 失败原因为 30 篇候选已全部耗尽；
- 当前账号和项目仍可用；
- 当前用户具有发布管理权限。

点击后应出现确认提示，明确说明：

- 原失败记录会保留；
- 将创建下一次尝试；
- 最多再生成 30 篇候选；
- 会产生新的 AI 调用成本；
- 不降低质量标准。

确认后页面应从“第 1 次尝试”切换为“第 2 次尝试”，新批次初始计数为 0，并在下一次 AI Worker
巡检后开始生成。

## 11. 数据库验收

查看最近批次：

```powershell
docker compose `
  --env-file .env `
  -p geo-content-os `
  -f infra\compose.yaml `
  exec -T postgres sh -lc `
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT business_date, attempt_no, status,
           last_error_json->>''code'' AS error_code,
           started_at, updated_at
    FROM official_site_daily_batches
    ORDER BY business_date DESC, attempt_no DESC
    LIMIT 20;
  "'
```

重发成功后，同一业务日期预期至少有两条记录：

| `attempt_no` | `status` | 含义 |
|---:|---|---|
| 1 | `cancelled` | 原失败批次，记录仍保留 |
| 2 | `running` | 新创建的当日尝试 |

确认审计事件：

```powershell
docker compose `
  --env-file .env `
  -p geo-content-os `
  -f infra\compose.yaml `
  exec -T postgres sh -lc `
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT action, resource_type, resource_id, created_at
    FROM audit_events
    WHERE action = ''official_site.daily_batch.restarted''
    ORDER BY created_at DESC
    LIMIT 20;
  "'
```

## 12. 常见问题

### 12.1 页面没有按钮

依次检查：

1. 是否已执行迁移 0040；
2. `api`、`web` 是否使用新镜像；
3. 批次是否为当天；
4. `last_error_json.code` 是否为 `DAILY_CANDIDATE_LIMIT_REACHED`；
5. 当前批次是否已经是 `running`、`scheduled` 或 `completed`；
6. 浏览器是否仍缓存旧页面。

可以先强制刷新浏览器，再检查 API 和 Web 日志。

### 12.2 点击后提示状态已变化

可能原因：

- 另一个管理员已经重发；
- AI Worker 已经改变批次状态；
- 页面持有旧批次版本。

关闭“官网自动发布”面板后重新打开。系统会重新读取最新批次；不要直接修改数据库版本号。

### 12.3 新批次创建后没有开始生成

检查：

```powershell
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml ps ai-worker
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml logs --tail 300 ai-worker
```

同时确认：

- `AI_MODEL_DRIVER=deepseek`；
- `DEEPSEEK_API_KEY` 有效；
- 项目存在已启用官网关键词；
- 品牌资料已发布；
- 知识资料已解析；
- 官网平台规则已发布；
- 官网 API 账号为 active。

### 12.4 重复点击会不会创建多个批次

不会。API 使用 Idempotency-Key 和批次版本校验，数据库还限制同一策略、同一天只能存在一个活动批次。

## 13. 回滚

迁移 0040 是前向迁移。旧版 AI Worker 依赖旧唯一约束，不能在保留迁移 0040 的情况下直接回滚。

出现问题时优先：

1. 在页面关闭每日自动发布设置，阻止新批次继续创建；
2. 停止 `ai-worker`；
3. 保留数据库和日志；
4. 修复后向前发布。

```powershell
docker compose `
  --env-file .env `
  -p geo-content-os `
  -f infra\compose.yaml `
  stop ai-worker
```

只有必须完整回退且可以接受丢弃升级后数据时，才能同时恢复：

- 升级前代码；
- 升级前 PostgreSQL 备份；
- 与升级前代码匹配的全部服务镜像。

不要只恢复代码而保留迁移后的数据库，也不要手工删除新批次或修改唯一约束。

## 14. 部署完成标准

以下项目全部满足才算部署完成：

- 迁移 0040 执行成功；
- API、Web、AI Worker healthy；
- 页面能显示当前尝试编号；
- 候选耗尽的当日批次能看到重发按钮；
- 点击一次只创建一个新批次；
- 旧批次和候选记录仍存在；
- 新批次开始生成；
- 审计事件已记录；
- 质量门禁和每批最多 30 篇候选保持不变。
