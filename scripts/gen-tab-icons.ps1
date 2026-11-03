<#
.SYNOPSIS
    生成底部 tabBar 的图标（首页 / 开奖 / 我的，各两套：默认灰 + 选中红）。

.DESCRIPTION
    小程序工程里没有二进制资源，tabBar 的 iconPath 又只认本地图片文件，
    所以这里用 GDI+ 直接画线稿图标并输出 PNG。

    画布 81×81（微信官方推荐尺寸），透明底，描边 5px、圆头圆角。
    颜色取自 app.wxss 的设计 token：
      默认 #9aa3ae（--text-muted）
      选中 #e8483f（--accent）

    三个图标的形状约定（跟首页工具箱的 SVG 线稿风格一致）：
      首页 —— 屋顶折线 + 房身
      开奖 —— 三行「圆点 + 横线」的列表（开奖记录）
      我的 —— 圆头 + 肩膀圆弧

.EXAMPLE
    .\gen-tab-icons.ps1 -OutDir "..\miniprogram\assets"
#>
[CmdletBinding()]
param(
    [string]$OutDir = (Join-Path $PSScriptRoot "..\miniprogram\assets")
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# 相对路径必须按脚本所在目录解析 —— [System.IO.Path]::GetFullPath 用的是
# 进程的当前目录，那不是脚本目录，传相对路径会写到工程外面去。
if (-not [System.IO.Path]::IsPathRooted($OutDir)) {
    $OutDir = Join-Path $PSScriptRoot $OutDir
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$SIZE = 81
$NORMAL = [System.Drawing.ColorTranslator]::FromHtml('#9aa3ae')
$ACTIVE = [System.Drawing.ColorTranslator]::FromHtml('#e8483f')

function New-Brush($color) {
    New-Object System.Drawing.SolidBrush($color)
}

function New-Pen($color) {
    $p = New-Object System.Drawing.Pen($color, 5)
    $p.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $p.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $p.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $p
}

function Draw-Home {
    param($g, $pen)
    # 屋顶
    $g.DrawLines($pen, [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point(16, 41)),
        (New-Object System.Drawing.Point(40, 18)),
        (New-Object System.Drawing.Point(64, 41))
    ))
    # 房身
    $g.DrawLines($pen, [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point(24, 37)),
        (New-Object System.Drawing.Point(24, 65)),
        (New-Object System.Drawing.Point(56, 65)),
        (New-Object System.Drawing.Point(56, 37))
    ))
}

function Draw-Draw {
    param($g, $pen)
    $brush = New-Brush $pen.Color
    $rows = @(
        @{ y = 23; x2 = 64 },
        @{ y = 41; x2 = 58 },
        @{ y = 59; x2 = 62 }
    )
    foreach ($r in $rows) {
        $g.FillEllipse($brush, 13, ($r.y - 4), 8, 8)
        $g.DrawLine($pen, 29, $r.y, $r.x2, $r.y)
    }
    $brush.Dispose()
}

function Draw-Mine {
    param($g, $pen)
    # 头
    $g.DrawEllipse($pen, 28, 16, 24, 24)
    # 肩膀：椭圆的上半圈
    $g.DrawArc($pen, 16, 38, 48, 48, 180, 180)
}

function Save-Icon {
    param(
        [string]$Name,
        [scriptblock]$Painter,
        [System.Drawing.Color]$Color
    )
    $bmp = New-Object System.Drawing.Bitmap($SIZE, $SIZE, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $pen = New-Pen $Color
    & $Painter $g $pen
    $pen.Dispose()
    $g.Dispose()

    $path = Join-Path $OutDir $Name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host ("  {0,-22} {1}" -f $Name, $path)
}

Write-Host '生成 tabBar 图标：'
Save-Icon 'tab-home.png'  { param($g, $p) Draw-Home $g $p } $NORMAL
Save-Icon 'tab-home-on.png'  { param($g, $p) Draw-Home $g $p } $ACTIVE
Save-Icon 'tab-draw.png'  { param($g, $p) Draw-Draw $g $p } $NORMAL
Save-Icon 'tab-draw-on.png'  { param($g, $p) Draw-Draw $g $p } $ACTIVE
Save-Icon 'tab-mine.png'  { param($g, $p) Draw-Mine $g $p } $NORMAL
Save-Icon 'tab-mine-on.png'  { param($g, $p) Draw-Mine $g $p } $ACTIVE

Write-Host '完成。'
