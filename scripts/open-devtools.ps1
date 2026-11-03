<#
.SYNOPSIS
    在微信开发者工具里打开本项目。

.DESCRIPTION
    调开发者工具 CLI 的 open 子命令。CLI 会自动发现已运行的 IDE；
    IDE 没开时按 --port 指定的端口拉起一个。

.EXAMPLE
    .\open-devtools.ps1
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [int]$IdePort = 24501
)

$ErrorActionPreference = 'Stop'

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path (Join-Path $ProjectRoot 'miniprogram'))) {
    throw "在 $ProjectRoot 下找不到 miniprogram 目录，请用 -ProjectRoot 指定项目根目录"
}

$cliCandidates = @(
    $env:WECHAT_DEVTOOLS_CLI,
    'O:\wx\cli.bat',
    'C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat',
    'C:\Program Files\Tencent\微信web开发者工具\cli.bat'
) | Where-Object { $_ -and (Test-Path $_) }

$cli = $cliCandidates | Select-Object -First 1
if (-not $cli) {
    throw "未找到微信开发者工具 CLI，请设置环境变量 WECHAT_DEVTOOLS_CLI 指向 cli.bat"
}

Write-Host "项目目录 : $ProjectRoot"
Write-Host "CLI      : $cli"
Write-Host "服务端口 : $IdePort"
Write-Host ""

# CLI 把进度写到 stderr，在 $ErrorActionPreference='Stop' 下会被当成致命错误直接中断，
# 但命令其实已经执行成功了。所以这里临时放宽策略，靠输出内容判成败。
$prevPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$output = & $cli open --project $ProjectRoot --port $IdePort --lang zh 2>&1 | ForEach-Object { $_.ToString() }
$ErrorActionPreference = $prevPreference

$output | ForEach-Object { Write-Host $_ }
exit $LASTEXITCODE
