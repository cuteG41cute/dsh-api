<#
  dsh-api 插件卸载脚本
  ====================
  从 DeepSeek Harness 实例移除 dsh-api 插件：

    1. 从 cordis.patch.yml 删除 install.ps1 注入的 dsh-api 插件行（标准注入块）
    2. 移除 profiles/<profile>/node_modules/dsh-api 包目录（移入备份目录）
    3. 重启 dsh web 后接口消失

  用法：
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-DshHome <DSH_HOME>] [-Profile web] [-Force]

  注意：只会删除 install.ps1 注入的标准块；手动编辑过的配置请手动清理。
#>
[CmdletBinding()]
param(
    [string]$DshHome = "",
    [string]$Profile = "web",
    [switch]$Force,
    [switch]$NoPrompt
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Message) Write-Host "[uninstall] $Message" }

if (-not $DshHome) { $DshHome = $env:DSH_HOME }
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $DshHome "profiles\$Profile"
$patchFile = Join-Path $profileDir "cordis.patch.yml"
$nodeModules = Join-Path $profileDir "node_modules"
$pkgDir = Join-Path $nodeModules "dsh-api"

Write-Step "profile : $profileDir"
if (-not (Test-Path $profileDir)) { Write-Error "profile 目录不存在：$profileDir"; exit 1 }

# ---- 1. 从 cordis.patch.yml 移除注入块 ----
if (Test-Path $patchFile) {
    $content = [System.IO.File]::ReadAllText($patchFile, [System.Text.Encoding]::UTF8)
    # 匹配 install.ps1 注入的标准块：注释头 + 整个顶层 `- insert:` 条目（含所有缩进行）。
    $pattern = "(?s)\r?\n# ── dsh-api:.*?\r?\n- insert:\r?\n(?:[ \t].*\r?\n)*"
    if ([regex]::IsMatch($content, $pattern)) {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        Copy-Item $patchFile (Join-Path $profileDir ".cordis.patch.yml.bak-$stamp") -Force
        Write-Step "已备份原配置 → .cordis.patch.yml.bak-$stamp"
        $new = [regex]::Replace($content, $pattern, "")
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($patchFile, $new, $utf8)
        Write-Step "已从 cordis.patch.yml 移除 dsh-api 插件行"
    } else {
        Write-Step "cordis.patch.yml 中未发现 dsh-api 注入块（跳过）"
    }
} else {
    Write-Step "未找到 $patchFile（跳过）"
}

# ---- 2. 移除插件包目录 ----
if (Test-Path $pkgDir) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $bk = Join-Path $nodeModules ".dsh-api-backup-$stamp"
    Move-Item $pkgDir $bk -Force
    Write-Step "插件包已移出 → $bk"
} else {
    Write-Step "未找到 $pkgDir（跳过）"
}

Write-Host ""
Write-Host "=========================================================="
Write-Host " dsh-api 卸载完成。重启 dsh web 后接口将不再提供。"
Write-Host " （备份文件可手动删除）"
Write-Host "=========================================================="
exit 0
