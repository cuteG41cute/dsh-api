<#
  dsh-api 插件安装脚本
  ====================
  把「DeepSeek Harness 对外 HTTP 接口」插件部署到一个 DeepSeek Harness 实例：

    1. 把插件包复制到 <DSH_HOME>/profiles/<profile>/node_modules/dsh-api/
    2. 在 <DSH_HOME>/profiles/<profile>/cordis.patch.yml 中注入 dsh-api 插件行
       （已有则跳过，幂等）
    3. 重启 dsh web 后接口即生效：http://127.0.0.1:3080/api/v1

  用法：
    powershell -ExecutionPolicy Bypass -File install.ps1 [-DshHome <DSH_HOME>] [-Profile web] [-ApiKey <key>] [-Force]

  参数：
    -DshHome  DSH 数据目录（含 profiles/ 的目录）；默认 $env:DSH_HOME，未设置则为 ~/.dsh
    -Profile  目标 profile（默认 web，必须包含 webServer 组件）
    -ApiKey   接口密钥；默认 dsh-api-demo-key（最终配置为
              `!!js process.env.DSH_API_KEY ?? '<key>'`，即优先读环境变量）
    -Force    不询问，直接执行

  备份：
    - 已存在的 node_modules/dsh-api 目录 → node_modules/.dsh-api-backup-<时间戳>
    - 原 cordis.patch.yml → <profile 目录>/.cordis.patch.yml.bak-<时间戳>

  卸载：uninstall.ps1（移除插件行与包目录）
#>
[CmdletBinding()]
param(
    [string]$DshHome = "",
    [string]$Profile = "web",
    [string]$ApiKey = "dsh-api-demo-key",
    [switch]$Force,
    [switch]$NoPrompt
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

function Write-Step { param([string]$Message) Write-Host "[install] $Message" }

# ---- 解析路径 ----
if (-not $DshHome) { $DshHome = $env:DSH_HOME }
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $DshHome "profiles\$Profile"
$patchFile = Join-Path $profileDir "cordis.patch.yml"
$nodeModules = Join-Path $profileDir "node_modules"
$pkgDest = Join-Path $nodeModules "dsh-api"

Write-Step "DSH_HOME : $DshHome"
Write-Step "profile  : $profileDir"

if (-not (Test-Path $profileDir)) {
    Write-Error "profile 目录不存在：$profileDir"
    Write-Error "请先运行一次 `dsh web`（或用 -DshHome/-Profile 指定已存在的 profile）。"
    exit 1
}

# ---- 1. 复制插件包 ----
if (-not (Test-Path (Join-Path $here "lib\index.js")) -or
    -not (Test-Path (Join-Path $here "lib\core.js")) -or
    -not (Test-Path (Join-Path $here "package.json"))) {
    Write-Error "插件文件不完整：本脚本必须与 package.json、lib/index.js、lib/core.js 在同一目录。"
    exit 1
}
New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null
if (Test-Path $pkgDest) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $bk = Join-Path $nodeModules ".dsh-api-backup-$stamp"
    Move-Item $pkgDest $bk -Force
    Write-Step "已备份旧插件包 → $bk"
}
New-Item -ItemType Directory -Force -Path $pkgDest | Out-Null
Copy-Item (Join-Path $here "package.json") (Join-Path $pkgDest "package.json") -Force
Copy-Item (Join-Path $here "README.md") (Join-Path $pkgDest "README.md") -Force
New-Item -ItemType Directory -Force -Path (Join-Path $pkgDest "lib") | Out-Null
Copy-Item (Join-Path $here "lib\index.js") (Join-Path $pkgDest "lib\index.js") -Force
Copy-Item (Join-Path $here "lib\core.js") (Join-Path $pkgDest "lib\core.js") -Force
Write-Step "插件包已复制到 $pkgDest"

# ---- 2. 注入 cordis.patch.yml ----
if (-not (Test-Path $patchFile)) {
    Write-Error "未找到 $patchFile —— 该 profile 没有 patch 文件，无法注入插件行。"
    Write-Error "（profile 目录应为 $profileDir，请确认 -Profile 参数。）"
    exit 1
}
if ($ApiKey -match "['""]") {
    Write-Error "ApiKey 不能包含单引号或双引号（会破坏 YAML 表达式）。请更换密钥。"
    exit 1
}
$existing = [System.IO.File]::ReadAllText($patchFile, [System.Text.Encoding]::UTF8)
if ($existing -match "(?m)^\s*- id:\s*dsh-api\s*$" -or $existing -match "name:\s*dsh-api") {
    Write-Step "cordis.patch.yml 已包含 dsh-api 行，跳过注入（如需更新配置请手动编辑）。"
} else {
    $block = @"

# ── dsh-api: DeepSeek Harness external agent HTTP API ───────────────────────
# Lets other agents call this harness over HTTP: POST /api/v1/tasks to submit
# a prompt, GET /api/v1/tasks/:taskId to fetch the reply, DELETE to cancel.
# Agent-facing docs: the dsh-api skill (SKILL.md) shipped with this plugin.
#
# apiKey defaults to `$`DSH_API_KEY or the key below. Change it for any deployment
# reachable beyond loopback. Empty string disables authentication (not recommended).
- insert:
    - id: dsh-api
      name: dsh-api
      inject: [webServer]
      config:
        prefix: /api/v1
        apiKey: !!js process.env.DSH_API_KEY ?? '$ApiKey'
        defaultPreset: standard
        defaultCwd: !!js process.cwd()
        defaultTimeoutMs: 1200000
        maxTimeoutMs: 7200000
        retentionMs: 600000
        maxConcurrent: 8
"@
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item $patchFile (Join-Path $profileDir ".cordis.patch.yml.bak-$stamp") -Force
    Write-Step "已备份原配置 → .cordis.patch.yml.bak-$stamp"
    $sep = if ($existing.EndsWith("`n")) { "" } else { "`n" }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($patchFile, $existing + $sep + $block + "`n", $utf8)
    Write-Step "已注入 dsh-api 插件行到 cordis.patch.yml"
}

# ---- 3. 完成 ----
Write-Host ""
Write-Host "=========================================================="
Write-Host " dsh-api 安装完成。下一步："
Write-Host "   1. 重启 dsh web（关闭并重新启动 DeepSeek Harness）"
Write-Host "   2. 验证：curl http://127.0.0.1:3080/api/v1/health -H 'X-API-Key: $ApiKey'"
Write-Host "   3. 使用文档：本包 skill/SKILL.md（或 harness 内的 dsh-api 技能）"
Write-Host "=========================================================="
exit 0
