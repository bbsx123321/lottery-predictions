<#
.SYNOPSIS
    重新探测本机环境并刷新 miniprogram/devtool.config.js。

.DESCRIPTION
    自检页和 README 里的「环境速查」都读 devtool.config.js。
    换机器、升级开发者工具、IDE 重启导致服务端口变了，跑一次这个脚本就能同步过来。

.EXAMPLE
    .\setup-check.ps1
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [int]$AutoPort = 9420
)

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

function Find-CliPath {
    $c = @(
        $env:WECHAT_DEVTOOLS_CLI,
        'O:\wx\cli.bat',
        'C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat',
        'C:\Program Files\Tencent\微信web开发者工具\cli.bat'
    ) | Where-Object { $_ -and (Test-Path $_) }
    return ($c | Select-Object -First 1)
}

# 注意：参数名不能叫 $args，那是 PowerShell 的自动变量，会把实参吃掉
function Get-ToolVersion([string]$Exe, [string[]]$ExeArgs) {
    try {
        $out = & $Exe @ExeArgs 2>&1 | Select-Object -First 1
        return ("$out").Trim()
    } catch {
        return "未检测到"
    }
}

$cli = Find-CliPath
if (-not $cli) {
    throw "未找到微信开发者工具 CLI，请设置环境变量 WECHAT_DEVTOOLS_CLI 指向 cli.bat"
}
$ideDir = Split-Path -Parent $cli

# --- 开发者工具可执行文件与版本 ---
$ideExe = Join-Path $ideDir '微信开发者工具.exe'
if (-not (Test-Path -LiteralPath $ideExe)) {
    $candidate = Get-ChildItem -LiteralPath $ideDir -Filter '*.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch 'uninstall|wxfilewatcher' } |
        Select-Object -First 1
    if ($candidate) { $ideExe = $candidate.FullName }
}

# 注册表的 DisplayVersion 带完整构建号（2.02.2608080），比 exe 的 ProductVersion 更精确
$ideVersion = '未知'
$regPaths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$ideEntry = Get-ItemProperty $regPaths -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like '*开发者工具*' } |
    Select-Object -First 1
if ($ideEntry -and $ideEntry.DisplayVersion) {
    $ideVersion = $ideEntry.DisplayVersion
} elseif (Test-Path -LiteralPath $ideExe) {
    $vi = (Get-Item -LiteralPath $ideExe).VersionInfo
    if ($vi.ProductVersion) { $ideVersion = $vi.ProductVersion }
}

# --- 服务端口（.ide 文件里就是当前 HTTP 服务端口）---
$userDataRoot = Join-Path $env:LOCALAPPDATA '微信开发者工具\User Data'
$idePort = ''
if (Test-Path -LiteralPath $userDataRoot) {
    $ideFile = Get-ChildItem -LiteralPath $userDataRoot -Recurse -Depth 2 -Filter '.ide' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($ideFile) {
        $idePort = (Get-Content -LiteralPath $ideFile.FullName -Raw -ErrorAction SilentlyContinue).Trim()
    }
}

# --- 基础库版本（User Data\<hash>\WeappVendor\<version>.wxvpkg）---
$baseLibrary = '未知'
if (Test-Path -LiteralPath $userDataRoot) {
    $pkg = Get-ChildItem -LiteralPath $userDataRoot -Recurse -Depth 4 -Filter '*.wxvpkg' -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -match '^\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.BaseName } -Descending |
        Select-Object -First 1
    if ($pkg) { $baseLibrary = $pkg.BaseName }
}

$nodeVersion = Get-ToolVersion 'node' @('-v')
$npmVersion = Get-ToolVersion 'npm' @('-v')
$gitVersion = Get-ToolVersion 'git' @('--version')
$npmRegistry = Get-ToolVersion 'npm' @('config', 'get', 'registry')

if (-not $idePort) { $idePort = '24501' }
if (-not $npmRegistry -or $npmRegistry -match 'npm ') { $npmRegistry = 'https://registry.npmjs.org/' }

$js = @"
/**
 * 本机开发环境速查表。
 *
 * 这份数据由 scripts/setup-check.ps1 自动生成，环境变了就重跑一次，
 * 首页「环境自检」和「速查」卡片直接读它，避免各处硬编码。
 */
module.exports = {
  idePath: "$ideExe",
  cliPath: "$cli",
  ideVersion: "$ideVersion",
  idePort: $idePort,
  autoPort: $AutoPort,
  baseLibrary: "$baseLibrary",
  nodeVersion: "$nodeVersion",
  npmVersion: "$npmVersion",
  gitVersion: "$gitVersion",
  npmRegistry: "$npmRegistry",
  projectRoot: "$ProjectRoot",
};
"@

$target = Join-Path $ProjectRoot 'miniprogram\devtool.config.js'
[System.IO.File]::WriteAllText($target, $js, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "已刷新 : $target"
Write-Host ""
Write-Host "开发者工具 : $ideVersion"
Write-Host "CLI        : $cli"
Write-Host "服务端口   : $idePort"
Write-Host "基础库     : $baseLibrary"
Write-Host "Node       : $nodeVersion / npm $npmVersion"
Write-Host "git        : $gitVersion"
Write-Host "npm 源     : $npmRegistry"

exit 0
