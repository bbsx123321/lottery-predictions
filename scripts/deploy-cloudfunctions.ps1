<#
.SYNOPSIS
    部署微信云开发云函数。

.DESCRIPTION
    调用微信开发者工具的 CLI，把 cloudfunctions/ 下的云函数上传并部署到指定云环境。
    依赖：微信开发者工具已安装、已登录，且已开启「服务端口」。

    关键：开发者工具 CLI 无论成功失败都返回退出码 0，
    所以这里从输出里解析 [error] / 部署失败 来判定成败。

.PARAMETER ProjectRoot
    小程序项目根目录（包含 cloudfunctions/ 与 miniprogram/）。默认取本脚本所在目录的上一级。

.PARAMETER EnvId
    云环境 ID。默认从 <ProjectRoot>\miniprogram\envList.js 里解析第一个 envId。

.PARAMETER Functions
    要部署的云函数名（对应 cloudfunctions/ 下的目录名）。默认 quickstartFunctions。

.PARAMETER IdePort
    开发者工具服务端口。不填时 CLI 会自动发现正在运行的 IDE。

.EXAMPLE
    .\deploy-cloudfunctions.ps1 -ProjectRoot 'D:\my\miniprogram' -Functions myApi
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [string]$EnvId = "",
    [string[]]$Functions = @("quickstartFunctions"),
    [string]$IdePort = ""
)

$ErrorActionPreference = 'Stop'

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path (Join-Path $ProjectRoot 'cloudfunctions'))) {
    throw "在 $ProjectRoot 下找不到 cloudfunctions 目录，请用 -ProjectRoot 指定项目根目录"
}

$cliCandidates = @(
    $env:WECHAT_DEVTOOLS_CLI,
    'C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat',
    'C:\Program Files\Tencent\微信web开发者工具\cli.bat',
    'O:\wx\cli.bat'
) | Where-Object { $_ -and (Test-Path $_) }

$cli = $cliCandidates | Select-Object -First 1
if (-not $cli) {
    throw "未找到微信开发者工具 CLI，请设置环境变量 WECHAT_DEVTOOLS_CLI 指向 cli.bat"
}

if (-not $EnvId) {
    $envListFile = Join-Path $ProjectRoot 'miniprogram\envList.js'
    if (-not (Test-Path $envListFile)) {
        throw "未找到 envList.js，无法推断云环境 ID，请用 -EnvId 显式指定"
    }
    $raw = Get-Content $envListFile -Raw -Encoding UTF8
    $m = [regex]::Match($raw, 'envId:\s*"([^"]+)"')
    if (-not $m.Success) {
        throw "未能从 envList.js 解析出 envId，请用 -EnvId 显式指定"
    }
    $EnvId = $m.Groups[1].Value
}

Write-Host "项目目录 : $ProjectRoot"
Write-Host "云环境   : $EnvId"
Write-Host "云函数   : $($Functions -join ', ')"
Write-Host "CLI      : $cli"
Write-Host ""

$cliArgs = @(
    'cloud', 'functions', 'deploy',
    '--env', $EnvId,
    '--names'
) + $Functions + @(
    '--project', $ProjectRoot,
    '--remote-npm-install',
    '--lang', 'zh'
)

if ($IdePort) {
    $cliArgs += @('--port', $IdePort)
}

# CLI 把进度写到 stderr，且无论成败退出码都是 0：放宽错误策略捕获输出，再从输出判定
$prevPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$output = & $cli @cliArgs 2>&1 | ForEach-Object { $_.ToString() }
$ErrorActionPreference = $prevPreference

$output | ForEach-Object { Write-Host $_ }

$text = $output -join "`n"
if ($text -match '\[error\]' -or $text -match '部署失败') {
    Write-Host ""
    Write-Host "云函数部署失败。" -ForegroundColor Red
    if ($text -match 'Creating') {
        Write-Host "提示：函数刚创建时线上状态是 Creating，等 30 秒后重新执行本脚本即可。" -ForegroundColor Yellow
    }
    exit 1
}

Write-Host ""
Write-Host "云函数部署完成。"
Write-Host "提示：定时触发器不会随本次部署上传（CLI 无此能力），需在控制台单独上传一次 config.json。"
