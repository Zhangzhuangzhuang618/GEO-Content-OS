[CmdletBinding()]
param(
    [switch]$MockAi,
    [switch]$SkipBuild,
    [switch]$SkipOwnerBootstrap,
    [switch]$NoOpenBrowser,
    [string]$OwnerEmail = "",
    [string]$OwnerDisplayName = "Windows Owner",
    [string]$TenantSlug = "demo-tech"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $ProjectRoot ".env"
$EnvExamplePath = Join-Path $ProjectRoot ".env.example"
$ComposePath = Join-Path $ProjectRoot "infra\compose.yaml"
$ProjectName = "geo-content-os"
$Services = @(
    "postgres",
    "redis",
    "minio",
    "clamav",
    "migrate",
    "api",
    "web",
    "outbox-relay",
    "publisher-worker",
    "baijiahao-browser",
    "sohu-browser",
    "lieju-browser",
    "ai-worker",
    "knowledge-worker"
)

Set-Location $ProjectRoot

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Docker {
    param([string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed: docker $($Arguments -join ' ')"
    }
}

function Get-EnvValue {
    param([string]$Name)
    if (-not (Test-Path $EnvPath)) {
        return ""
    }
    foreach ($Line in [System.IO.File]::ReadAllLines($EnvPath)) {
        if ($Line -match "^\s*$([regex]::Escape($Name))=(.*)$") {
            return $Matches[1].Trim()
        }
    }
    return ""
}

function Set-EnvValue {
    param(
        [string]$Name,
        [string]$Value
    )
    $Lines = [System.Collections.Generic.List[string]]::new()
    $Found = $false
    foreach ($Line in [System.IO.File]::ReadAllLines($EnvPath)) {
        if ($Line -match "^\s*$([regex]::Escape($Name))=") {
            $Lines.Add("$Name=$Value")
            $Found = $true
        }
        else {
            $Lines.Add($Line)
        }
    }
    if (-not $Found) {
        $Lines.Add("$Name=$Value")
    }
    $Utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllLines($EnvPath, $Lines, $Utf8WithoutBom)
}

function New-RandomBytes {
    param([int]$Count)
    $Bytes = New-Object byte[] $Count
    $Generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $Generator.GetBytes($Bytes)
    }
    finally {
        $Generator.Dispose()
    }
    return $Bytes
}

function New-RandomHex {
    param([int]$ByteCount)
    return ([System.BitConverter]::ToString((New-RandomBytes $ByteCount))).Replace("-", "").ToLowerInvariant()
}

function New-RandomBase64 {
    param([int]$ByteCount)
    return [Convert]::ToBase64String((New-RandomBytes $ByteCount))
}

function ConvertTo-PlainText {
    param([Security.SecureString]$SecureValue)
    $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
    }
}

function Read-ConfirmedSecret {
    param(
        [string]$Prompt,
        [int]$MinimumLength,
        [int]$MaximumLength
    )
    while ($true) {
        $First = ConvertTo-PlainText (Read-Host $Prompt -AsSecureString)
        $Second = ConvertTo-PlainText (Read-Host "请再次输入以确认" -AsSecureString)
        if ($First -ne $Second) {
            Write-Warning "两次输入不一致，请重试。"
            continue
        }
        if ($First.Length -lt $MinimumLength -or $First.Length -gt $MaximumLength) {
            Write-Warning "长度必须为 $MinimumLength 到 $MaximumLength 个字符。"
            continue
        }
        return $First
    }
}

function Wait-ServiceHealthy {
    param(
        [string]$Service,
        [int]$TimeoutSeconds = 300
    )
    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $Deadline) {
        $IdArguments = @(
            "compose", "--env-file", $EnvPath,
            "-p", $ProjectName,
            "-f", $ComposePath,
            "ps", "-q", $Service
        )
        $ContainerId = (& docker @IdArguments | Select-Object -First 1)
        if ($ContainerId) {
            $Status = (& docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" $ContainerId).Trim()
            if ($Status -eq "healthy" -or $Status -eq "running") {
                Write-Host "  $Service`: $Status" -ForegroundColor Green
                return
            }
            if ($Status -eq "unhealthy" -or $Status -eq "exited" -or $Status -eq "dead") {
                throw "$Service entered state: $Status"
            }
        }
        Start-Sleep -Seconds 3
    }
    throw "Timed out waiting for $Service"
}

Write-Step "检查 Docker Desktop"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "未找到 docker。请安装并启动 Docker Desktop，然后切换到 Linux containers。"
}
Invoke-Docker @("version")
Invoke-Docker @("compose", "version")

Write-Step "准备环境变量"
$CreatedEnv = $false
if (-not (Test-Path $EnvPath)) {
    if (-not (Test-Path $EnvExamplePath)) {
        throw "缺少 .env.example"
    }
    Copy-Item $EnvExamplePath $EnvPath
    $CreatedEnv = $true
    Write-Host "已从 .env.example 创建 .env"
}

if ($CreatedEnv) {
    Set-EnvValue "POSTGRES_PASSWORD" (New-RandomHex 24)
    Set-EnvValue "MINIO_ROOT_PASSWORD" (New-RandomHex 24)
}
if (-not (Get-EnvValue "PUBLISHING_CREDENTIAL_KEY_BASE64")) {
    Set-EnvValue "PUBLISHING_CREDENTIAL_KEY_BASE64" (New-RandomBase64 32)
}
if (-not (Get-EnvValue "BAIJIAHAO_BROWSER_GATEWAY_TOKEN")) {
    Set-EnvValue "BAIJIAHAO_BROWSER_GATEWAY_TOKEN" (New-RandomHex 32)
}
if (-not (Get-EnvValue "SOHU_BROWSER_GATEWAY_TOKEN")) {
    Set-EnvValue "SOHU_BROWSER_GATEWAY_TOKEN" (New-RandomHex 32)
}
if (-not (Get-EnvValue "LIEJU_BROWSER_GATEWAY_TOKEN")) {
    Set-EnvValue "LIEJU_BROWSER_GATEWAY_TOKEN" (New-RandomHex 32)
}

if ($MockAi) {
    Set-EnvValue "AI_MODEL_DRIVER" "mock"
    Set-EnvValue "DEEPSEEK_API_KEY" ""
}
else {
    $DeepSeekKey = Get-EnvValue "DEEPSEEK_API_KEY"
    if (-not $DeepSeekKey) {
        $DeepSeekKey = ConvertTo-PlainText (Read-Host "请输入 DeepSeek API Key（输入不会显示）" -AsSecureString)
        if (-not $DeepSeekKey) {
            throw "未配置 DeepSeek API Key；如需 Mock 模式，请使用 -MockAi。"
        }
        Set-EnvValue "DEEPSEEK_API_KEY" $DeepSeekKey
    }
    Set-EnvValue "AI_MODEL_DRIVER" "deepseek"
}

$PublishingKey = Get-EnvValue "PUBLISHING_CREDENTIAL_KEY_BASE64"
try {
    $PublishingKeyBytes = [Convert]::FromBase64String($PublishingKey)
}
catch {
    throw "PUBLISHING_CREDENTIAL_KEY_BASE64 不是有效 Base64。"
}
if ($PublishingKeyBytes.Length -ne 32) {
    throw "PUBLISHING_CREDENTIAL_KEY_BASE64 必须解码为 32 字节。"
}

Write-Step "构建并启动核心服务"
$UpArguments = @(
    "compose", "--env-file", $EnvPath,
    "-p", $ProjectName,
    "-f", $ComposePath,
    "up", "-d"
)
if (-not $SkipBuild) {
    $UpArguments += "--build"
}
$UpArguments += $Services
Invoke-Docker $UpArguments

Write-Step "等待服务健康"
foreach ($Service in @("postgres", "redis", "minio", "clamav", "api", "web", "outbox-relay", "publisher-worker", "baijiahao-browser", "sohu-browser", "lieju-browser", "ai-worker", "knowledge-worker")) {
    Wait-ServiceHealthy $Service
}

Write-Step "写入可重复执行的演示基线数据"
$ComposePrefix = @(
    "compose", "--env-file", $EnvPath,
    "-p", $ProjectName,
    "-f", $ComposePath
)
Invoke-Docker ($ComposePrefix + @("exec", "-T", "api", "node", "apps/api/dist/database/seeds/cli.js"))

if (-not $SkipOwnerBootstrap) {
    Write-Step "初始化租户 Owner"
    if (-not $OwnerEmail) {
        $OwnerEmail = Read-Host "Owner 邮箱（默认 owner@example.com）"
        if (-not $OwnerEmail) {
            $OwnerEmail = "owner@example.com"
        }
    }
    $OwnerPassword = Read-ConfirmedSecret "请输入 Owner 密码（12-128 位，输入不会显示）" 12 128
    $Payload = @{
        display_name = $OwnerDisplayName
        email = $OwnerEmail
        password = $OwnerPassword
        tenant_slug = $TenantSlug
    } | ConvertTo-Json -Compress
    $BootstrapArguments = $ComposePrefix + @(
        "exec", "-T", "api", "node", "scripts/bootstrap-owner.mjs"
    )
    $Payload | & docker @BootstrapArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Owner 初始化失败。"
    }
    $OwnerPassword = $null
    $Payload = $null
}

Write-Step "部署完成"
$WebPort = Get-EnvValue "WEB_PORT"
$ApiPort = Get-EnvValue "API_PORT"
$MinioConsolePort = Get-EnvValue "MINIO_CONSOLE_PORT"
if (-not $WebPort) { $WebPort = "3000" }
if (-not $ApiPort) { $ApiPort = "3001" }
if (-not $MinioConsolePort) { $MinioConsolePort = "9001" }

$WebUrl = "http://localhost:$WebPort"
Write-Host "Web:          $WebUrl" -ForegroundColor Green
Write-Host "API health:   http://localhost:$ApiPort/api/v1/health/ready"
Write-Host "MinIO:        http://localhost:$MinioConsolePort"
Write-Host ""
Write-Host "环境密钥位于 .env。请备份并禁止提交到 Git。" -ForegroundColor Yellow

if (-not $NoOpenBrowser) {
    Start-Process $WebUrl
}
