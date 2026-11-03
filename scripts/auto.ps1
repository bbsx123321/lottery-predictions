<#
.SYNOPSIS
    开启小程序自动化通道（miniprogram-automator 的 websocket 端点）。

.DESCRIPTION
    两个端口别搞混：
      --port      开发者工具「设置 → 安全设置 → 服务端口」，CLI 连 IDE 用
      --auto-port 自动化 websocket 端口，miniprogram-automator 连它

    IDE 重启后自动化端口可能变，连不上先用这个确认：
      netstat -ano | Select-String ':9420'

.EXAMPLE
    .\auto.ps1
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [int]$IdePort = 24501,
    [int]$AutoPort = 9420
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

Write-Host "项目目录   : $ProjectRoot"
Write-Host "服务端口   : $IdePort"
Write-Host "自动化端口 : $AutoPort"
Write-Host ""
Write-Host "通道就绪后跑验证： cd scripts; npm run verify" -ForegroundColor Cyan
Write-Host ""

# CLI 把进度写到 stderr，在 $ErrorActionPreference='Stop' 下会被当成致命错误直接中断，
# 但命令其实已经执行成功了。所以这里临时放宽策略。
$prevPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$output = & $cli auto --project $ProjectRoot --port $IdePort --auto-port $AutoPort --lang zh 2>&1 | ForEach-Object { $_.ToString() }
$ErrorActionPreference = $prevPreference

$output | ForEach-Object { Write-Host $_ }
exit $LASTEXITCODE
