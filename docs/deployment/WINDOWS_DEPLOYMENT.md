# GEO Content OS Windows 部署手册

## 1. 文档范围

本文用于在 Windows 10/11 上通过 Docker Desktop 和 Linux containers 部署 GEO Content OS。
适用场景：

- 本地开发、产品演示和验收环境；
- 企业内网单机试运行；
- Windows 运维终端管理远端 Docker 主机。

当前镜像全部基于 Linux。不要切换到 Windows containers。Windows Server 正式生产环境建议在
Hyper-V、VMware 或云平台中建立 Linux 虚拟机，再在 Linux 内运行 Compose；不建议把 Docker
Desktop 当作长期生产容器平台。

一键脚本启动当前可用的核心链路：

```text
Web -> API -> PostgreSQL / MinIO / Redis
                    |
                    +-> Outbox Relay -> AI Worker -> DeepSeek
                                      -> Publisher Worker -> configured platform API
                                                          -> Baijiahao Browser (internal)
                                      -> Knowledge Worker -> ClamAV / Parser / Embedding
```

脚本会启动已接入真实队列消费者的 `publisher-worker`；T145 百家号自动化还必须启动独立的 `baijiahao-browser`。不会启动仍使用通用健康占位镜像的 `analytics-worker` 和
`lifecycle-worker`。启用官网自动发布策略并配置真实官网 API 账号后，Publisher Worker 会执行远程发布；首次部署和本地验收不得配置生产官网地址或令牌。`knowledge-worker` 是真实队列消费者，
会执行安全扫描、网页抓取或文件解析、分块与向量化。

## 2. 推荐配置

### 2.1 最低配置

- Windows 10 22H2 或 Windows 11，64 位；
- CPU：4 核；
- 内存：16 GB；
- 可用磁盘：60 GB；
- Docker Desktop 可分配内存：至少 8 GB；
- 稳定访问 Docker Hub、npm registry 和 DeepSeek API 的网络。

### 2.2 建议配置

- CPU：8 核及以上；
- 内存：32 GB；
- SSD 可用空间：100 GB 及以上；
- Docker Desktop 分配：8 核、16 GB 内存、2 GB Swap；
- 数据量较大时，把 Docker Desktop 的虚拟磁盘放到非系统盘。

首次构建需要下载 Node、PostgreSQL/pgvector、Redis、MinIO 和 pnpm 依赖，通常需要
10–30 分钟，具体取决于网络。

## 3. 安装基础软件

### 3.1 启用 WSL2

使用管理员 PowerShell 执行：

```powershell
wsl --install
wsl --update
```

执行后重启 Windows。检查：

```powershell
wsl --status
wsl --version
```

如果 BIOS/UEFI 未启用虚拟化，需要先启用 Intel VT-x 或 AMD-V。

### 3.2 安装 Docker Desktop

安装 Docker Desktop 后确认：

1. Settings -> General -> Use the WSL 2 based engine 已启用；
2. Docker 菜单显示 “Switch to Windows containers” 时，说明当前已经是 Linux containers；
3. Settings -> Resources 中分配足够 CPU、内存和磁盘；
4. Docker Desktop 已完全启动。

检查：

```powershell
docker version
docker compose version
docker run --rm hello-world
```

### 3.3 获取项目

可以使用 Git 克隆，也可以解压项目压缩包。建议目录简短且不在 OneDrive 同步目录中，例如：

```text
D:\GEO-Content-OS
```

Git 方式：

```powershell
git clone <项目仓库地址> D:\GEO-Content-OS
Set-Location D:\GEO-Content-OS
```

## 4. 一键部署

### 4.1 允许本次 PowerShell 脚本运行

普通 PowerShell 中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

该设置只对当前 PowerShell 窗口有效，不修改系统永久策略。

### 4.2 运行一键脚本

在项目根目录执行：

```powershell
.\scripts\deploy-windows.ps1
```

脚本会依次完成：

1. 检查 Docker Desktop 和 Docker Compose；
2. 从 `.env.example` 创建 `.env`；
3. 首次部署时生成 PostgreSQL、MinIO 和平台凭证加密密钥；
4. 安全提示输入 DeepSeek API Key，输入内容不会显示；
5. 构建镜像并启动核心服务；
6. 等待 PostgreSQL、Redis、MinIO、ClamAV、API、Web、Outbox Relay、AI Worker 和 Knowledge Worker 健康；
7. 执行项目当前全部数据库迁移；
8. 写入可重复执行的冻结演示基线；
9. 安全提示创建租户 Owner 登录账号；
10. 打开 `http://localhost:3000`。

Owner 密码必须为 12–128 个非控制字符。密码仅通过标准输入传入 API 容器，使用项目同款
Argon2id 参数生成哈希，不会写入脚本、命令行参数或日志。

### 4.3 使用 Mock AI

没有 DeepSeek Key 时：

```powershell
.\scripts\deploy-windows.ps1 -MockAi
```

Mock 仅用于本地流程验证，不代表真实模型质量，不允许作为生产模式。

### 4.4 常用参数

跳过镜像重建：

```powershell
.\scripts\deploy-windows.ps1 -SkipBuild
```

不创建或更新 Owner：

```powershell
.\scripts\deploy-windows.ps1 -SkipOwnerBootstrap
```

预填 Owner 邮箱，但密码仍安全交互输入：

```powershell
.\scripts\deploy-windows.ps1 -OwnerEmail "owner@example.com"
```

部署后不自动打开浏览器：

```powershell
.\scripts\deploy-windows.ps1 -NoOpenBrowser
```

参数可以组合：

```powershell
.\scripts\deploy-windows.ps1 -SkipBuild -OwnerEmail "owner@example.com" -NoOpenBrowser
```

## 5. 手工配置 `.env`

脚本会自动创建 `.env`。如果需要手工配置：

```powershell
Copy-Item .env.example .env
notepad .env
```

核心配置：

```dotenv
AI_MODEL_DRIVER=deepseek
DEEPSEEK_API_KEY=<真实Key>
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL_KEY=deepseek-v4-flash
DEEPSEEK_PROVIDER_MODEL_ID=deepseek-v4-flash

CONTENT_MODEL_FAST_KEY=deepseek-v4-flash
CONTENT_MODEL_BALANCED_KEY=deepseek-v4-flash
CONTENT_MODEL_QUALITY_KEY=deepseek-v4-pro
QUALITY_CHECKER_MODEL_KEY=deepseek-v4-pro

PUBLISHING_CREDENTIAL_KEY_BASE64=<32字节随机值的Base64>
PUBLISHING_CREDENTIAL_KEY_VERSION=local-v1
BAIJIAHAO_BROWSER_GATEWAY_TOKEN=<至少32位随机内部密钥>
BAIJIAHAO_BROWSER_HEADLESS=true

API_BIND_ADDRESS=127.0.0.1
TRUST_PROXY_HOPS=1
RATE_LIMIT_MAX=300
RATE_LIMIT_WINDOW_MS=60000
```

PowerShell 生成 32 字节平台凭证加密密钥：

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
[Convert]::ToBase64String($bytes)
```

如果 Windows 已安装 OpenSSL，也可以在任意目录执行：

```powershell
openssl rand -base64 32
```

命令所在目录不影响生成结果。把完整输出粘贴到
`PUBLISHING_CREDENTIAL_KEY_BASE64=` 后面，不加引号。

注意：

- `.env` 已被 `.gitignore` 忽略，但仍应限制文件访问权限；
- 不要把 Key 发到聊天、工单、截图或日志；
- 平台账号凭证写入后，不要直接替换加密密钥；
- 更换密钥必须先实现凭证重加密流程，否则已有凭证无法解密；
- 单个 AI Worker 当前加载一个模型 Adapter，三个内容策略应使用同一逻辑 model key。

## 6. 手工部署命令

必须显式指定根目录 `.env`。由于 Compose 文件在 `infra` 目录，仅使用 `-f` 而不使用
`--env-file` 时，Compose 不会自动读取项目根目录 `.env`。

```powershell
docker compose `
  --env-file .env `
  -p geo-content-os `
  -f infra\compose.yaml `
  up -d --build `
  postgres redis minio migrate baijiahao-browser api web outbox-relay publisher-worker ai-worker
```

查看状态：

```powershell
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml ps
```

查看日志：

```powershell
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml logs -f api web ai-worker outbox-relay publisher-worker baijiahao-browser
```

停止但保留数据：

```powershell
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml stop
```

重新启动：

```powershell
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml start
```

删除容器但保留数据卷：

```powershell
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml down
```

不要随意执行：

```powershell
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml down -v
```

`-v` 会删除 PostgreSQL、Redis 和 MinIO 数据卷。

## 7. 访问地址

默认端口：

| 服务 | 地址 | 用途 |
|---|---|---|
| Web | `http://localhost:3000` | 系统页面和登录入口 |
| API | `http://127.0.0.1:3001` | 仅限服务器本机诊断，业务页面通过 Web 同源代理访问 |
| API 健康检查 | `http://127.0.0.1:3001/api/v1/health/ready` | 返回 200 表示 API 就绪 |
| MinIO Console | `http://localhost:9001` | 对象存储管理 |
| PostgreSQL | `localhost:5432` | 数据库客户端连接 |
| Redis | `localhost:6379` | 队列与缓存 |

Web 已配置同源 `/api/v1` 反向代理，浏览器访问 Web 时不需要直接调用 API 端口。
默认只把 API 端口绑定到 `127.0.0.1`，并信任 Web 容器这一跳代理，以便按真实客户端 IP
隔离限流。不要把 `API_BIND_ADDRESS` 改成 `0.0.0.0` 后仍保留 `TRUST_PROXY_HOPS=1`，
否则局域网客户端可以直接伪造代理来源头。

如果要从局域网另一台电脑访问：

1. 使用 `http://<Windows主机IP>:3000`；
2. 在 Windows Defender 防火墙中仅向可信网段开放 Web 端口；
3. 不要向公网暴露 5432、6379、9000；
4. Web 写操作已兼容普通局域网 HTTP 环境；正式环境仍应在 Web 前增加 HTTPS 反向代理；
5. `PUBLIC_APP_URL`、Cookie Secure 策略和可信代理头需要按正式域名配置。

## 8. Owner 初始化

一键脚本会交互创建 Owner。需要在服务启动后新增或重置 Owner 时，可以再次调用脚本并跳过
镜像构建：

```powershell
.\scripts\deploy-windows.ps1 -SkipBuild -OwnerEmail "owner@example.com"
```

初始化工具可重复执行：同邮箱会更新密码和显示名、恢复 active 状态、授予
`tenant_owner`，并撤销该用户已有会话。密码通过 SecureString 交互读取，不要把密码写进
PowerShell 命令参数。

## 9. 更新部署

拉取代码后：

```powershell
git pull
.\scripts\deploy-windows.ps1
```

脚本会重新构建镜像、执行幂等迁移和演示 Seed。升级前应先备份数据库和 `.env`。

如果仅修改 `.env`：

```powershell
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml up -d --no-build --force-recreate api ai-worker
```

DeepSeek Key 只需要重建 AI Worker；平台凭证加密密钥只需要重建 API。

## 10. 备份

### 10.1 必须备份的内容

- 项目根目录 `.env`；
- Docker volume `geo-content-os_postgres-data`；
- Docker volume `geo-content-os_minio-data`；
- 必要时备份 Redis AOF，但 Redis 不是业务事实源。

### 10.2 PostgreSQL 逻辑备份

```powershell
New-Item -ItemType Directory -Force .\backup | Out-Null
docker exec geo-content-os-postgres-1 `
  pg_dump -U geo -d geo_content_os_dev -Fc -f /tmp/geo-content-os.dump
docker cp geo-content-os-postgres-1:/tmp/geo-content-os.dump `
  .\backup\geo-content-os.dump
docker exec geo-content-os-postgres-1 rm -f /tmp/geo-content-os.dump
```

恢复前先停止 API 和 Worker，并在隔离环境验证备份。不要直接覆盖正在运行的生产数据库。

## 11. 故障排查

### 11.1 Docker daemon 未启动

症状：

```text
error during connect
```

处理：

- 启动 Docker Desktop；
- 等待状态变为 Engine running；
- 确认当前为 Linux containers；
- 重新执行 `docker version`。

### 11.2 WSL2 或虚拟化错误

```powershell
wsl --update
wsl --shutdown
```

重启 Docker Desktop。如果仍失败，检查 BIOS 虚拟化和 Windows 功能：

- Virtual Machine Platform；
- Windows Subsystem for Linux；
- Hyper-V（系统版本支持时）。

### 11.3 端口被占用

查看端口：

```powershell
Get-NetTCPConnection -State Listen |
  Where-Object LocalPort -In 3000,3001,5432,6379,9000,9001
```

可以在 `.env` 修改：

```dotenv
WEB_PORT=3100
API_PORT=3101
POSTGRES_PORT=55432
REDIS_PORT=56379
MINIO_API_PORT=59000
MINIO_CONSOLE_PORT=59001
```

修改后重新运行一键脚本。

### 11.4 Web 能打开但 API 请求 404

确认 Web 镜像为最新版本：

```powershell
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml build --no-cache web
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml up -d --force-recreate web
```

检查同源代理：

```powershell
Invoke-WebRequest http://localhost:3000/api/v1/health/ready
```

应返回 HTTP 200。

### 11.5 API 或 AI Worker 不健康

```powershell
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml ps
docker compose --env-file .env -p geo-content-os -f infra\compose.yaml logs --tail 200 api ai-worker outbox-relay publisher-worker baijiahao-browser
```

常见原因：

- `.env` 没有通过 `--env-file .env` 加载；
- DeepSeek Key 无效；
- `AI_MODEL_DRIVER` 未设为 `deepseek`；
- `PUBLISHING_CREDENTIAL_KEY_BASE64` 不是 32 字节 Base64；
- `BAIJIAHAO_BROWSER_GATEWAY_TOKEN` 缺失或短于 32 位；
- Docker Desktop 内存不足；
- 依赖下载或访问 DeepSeek 的网络失败。

### 11.6 修改 PostgreSQL 密码后无法连接

PostgreSQL 初始化后，容器内密码保存在数据卷中。只修改 `.env` 不会自动修改已有数据库
用户密码。测试环境可在确认数据不需要后删除数据卷重建；有数据时必须使用 SQL 正式修改
数据库密码，不能执行 `down -v`。

### 11.7 构建缓慢或 npm 下载失败

- 确认 Docker Desktop 可以访问互联网；
- 配置企业代理时，同时配置 Docker Desktop 代理；
- 重试一键脚本；
- 不要在构建中途关闭 Docker Desktop；
- 已有最新镜像时可以使用 `-SkipBuild`。

## 12. 生产化前检查

当前 Compose 适合本地和内网验收，不是直接公网暴露的最终生产模板。生产化至少需要：

- Linux 服务器或 Linux 虚拟机；
- HTTPS 反向代理和正式域名；
- 将 `AUTH_COOKIE_SECURE` 设置为 `true`；本地 HTTP 验收环境保持 `false`，否则 Safari 不会保存登录 Cookie；
- PostgreSQL、Redis、MinIO 不暴露公网端口；
- 外部密钥管理服务，不把长期密钥只放在 `.env`；
- PostgreSQL 定期备份、恢复演练和异地副本；
- 日志、指标、告警和磁盘容量监控；
- DeepSeek 费率卡和预算阈值；
- 平台账号最小权限、密钥轮换和审计；
- 明确真实平台 Adapter 的能力范围；
- 正式发布前执行安全、迁移、E2E 和回滚验收。
