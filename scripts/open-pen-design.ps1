<#
.SYNOPSIS
    Open a .pen design file in the Pencil desktop app and bring it to the front.

.DESCRIPTION
    The Pencil desktop app (Pen.exe) does NOT open the .pen file passed on the
    command line - it launches into the Dashboard and creates an empty
    "untitled.pen" instead. The only reliable way to load a specific file is
    the Dashboard's "Open File" button, so this script drives the UI:

      1. locate the Pen window and raise it
      2. click the "Open File" button (located by UI Automation name)
      3. paste the absolute .pen path into the native file dialog and confirm

    Two quirks of the Vista-style file dialog cost real time - both are handled:
      - the path must go in via the CLIPBOARD. SendKeys drops the spaces and
        the Chinese-locale dialog eats characters.
      - the shell does an INLINE AUTO-COMPLETE on paste: it appends the matched
        file name, so the box ends up as "...\home.penhome.pen". One {DEL}
        right after the paste removes the auto-completed suffix.

    After this, the pencil MCP server can operate on the file directly.

.PARAMETER PenFile
    Absolute path of the .pen file to open.

.EXAMPLE
    .\open-pen-design.ps1 -PenFile "D:\work\design\home.pen"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PenFile
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $PenFile)) {
    throw "File not found: $PenFile"
}
$PenFile = (Resolve-Path -LiteralPath $PenFile).Path

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('PenOpen.Native' -as [type])) {
    Add-Type -Namespace PenOpen -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
'@
}

$AE   = [System.Windows.Automation.AutomationElement]
$TS   = [System.Windows.Automation.TreeScope]
$PenExe = 'O:\package\Pen\Pen.exe'

function Click-At {
    param([int]$X, [int]$Y)
    [PenOpen.Native]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 280
    [PenOpen.Native]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
    Start-Sleep -Milliseconds 60
    [PenOpen.Native]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
}

function Get-PenWindow {
    $procs = @(Get-Process -Name 'Pen' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 })
    if ($procs.Count -eq 0) { return [IntPtr]::Zero }
    return $procs[0].MainWindowHandle
}

function Find-ByName {
    param([System.Windows.Automation.AutomationElement]$Root, [string]$Name)
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Name)
    return $Root.FindFirst($TS::Descendants, $c)
}

Write-Host "Pen file : $PenFile"

# ---- 1. raise the app -------------------------------------------------------
$handle = Get-PenWindow
if ($handle -eq [IntPtr]::Zero) {
    if (-not (Test-Path -LiteralPath $PenExe)) { throw "Pen.exe not found at $PenExe" }
    Start-Process -FilePath $PenExe | Out-Null
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 1
        $handle = Get-PenWindow
        if ($handle -ne [IntPtr]::Zero) { break }
    }
    if ($handle -eq [IntPtr]::Zero) { throw 'Pen window did not appear.' }
}

[PenOpen.Native]::ShowWindow($handle, 9) | Out-Null   # SW_RESTORE
[PenOpen.Native]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Seconds 2

# ---- 2. click "Open File" ----------------------------------------------------
# On a cold start the Dashboard needs a few seconds to render, so poll for the
# button instead of looking once.
$clickedOpen = $false
$openBtn = $null
for ($i = 0; $i -lt 40; $i++) {
    $root = $AE::FromHandle((Get-PenWindow))
    if ($root) {
        $openBtn = Find-ByName -Root $root -Name 'Open File'
        if ($openBtn) { break }
    }
    Start-Sleep -Milliseconds 500
}

if (-not $openBtn) {
    Write-Host 'Open File button not found - a document may already be open.'
} else {
    $rect = $openBtn.Current.BoundingRectangle
    $cx = [int]($rect.X + $rect.Width / 2)
    $cy = [int]($rect.Y + $rect.Height / 2)
    Write-Host ("Open File button at {0},{1}" -f $cx, $cy)

    [PenOpen.Native]::SetForegroundWindow($handle) | Out-Null
    Start-Sleep -Milliseconds 400
    Click-At -X $cx -Y $cy
    Start-Sleep -Seconds 3
    $clickedOpen = $true
}

# ---- 3. drive the native file dialog ----------------------------------------
if (-not $clickedOpen) {
    Start-Sleep -Seconds 1
} else {
$dlg = $null
for ($i = 0; $i -lt 30; $i++) {
    $fc = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32770')
    $dlg = $AE::RootElement.FindFirst($TS::Children, $fc)
    if ($dlg) { break }
    Start-Sleep -Milliseconds 500
}

if (-not $dlg) {
    Write-Host 'File dialog not detected - click Open File and pick the path manually.'
    exit 1
}
Write-Host ("File dialog: '" + $dlg.Current.Name + "'")

# 对话框不在前台时，合成的鼠标点击会落到别的窗口上（这点过一次），
# 所以先把对话框自己置前。
$dlgHwnd = [IntPtr]$dlg.Current.NativeWindowHandle
if ($dlgHwnd -ne [IntPtr]::Zero) {
    [PenOpen.Native]::ShowWindow($dlgHwnd, 9) | Out-Null   # SW_RESTORE
    [PenOpen.Native]::SetForegroundWindow($dlgHwnd) | Out-Null
    Start-Sleep -Milliseconds 700
}

# ---- 3a. 首选：在文件列表里按名字选中目标文件，再点「打开」 ------------------
# 这条路最稳：不用剪贴板、不用 SendKeys，中英文系统都能用。
$opened = $false
$leaf = Split-Path -Leaf $PenFile
$itemCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $leaf)
$item = $dlg.FindFirst($TS::Descendants, $itemCond)

if ($item) {
    try {
        $sel = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $sel.Select()
        Start-Sleep -Milliseconds 600
    } catch {
        Write-Host ('  选中失败: ' + $_.Exception.Message)
    }

    $openBtn = $null
    foreach ($btnName in @('打开(O)', 'Open(O)', '打开', 'Open')) {
        $bc = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $btnName)
        $openBtn = $dlg.FindFirst($TS::Descendants, $bc)
        if ($openBtn) { break }
    }
    if ($openBtn) {
        $br = $openBtn.Current.BoundingRectangle
        $bx = [int]($br.X + $br.Width / 2)
        $by = [int]($br.Y + $br.Height / 2)
        Write-Host ("  打开按钮 at {0},{1}" -f $bx, $by)
        Click-At -X $bx -Y $by
        Start-Sleep -Seconds 4
        $opened = $true
    }
}

# ---- 3b. 兜底：往「文件名」框里粘贴绝对路径 -------------------------------
if (-not $opened) {
    # 「文件名(N):」在中文系统里是一个 ClassName=Static 的 Pane，
    # 不是 Text 控件 —— 早期按 ControlType=Text 找过，一直找不到。
    $labelCond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'Static')
    $labels = $dlg.FindAll($TS::Descendants, $labelCond)

    $editX = 0
    $editY = 0
    for ($i = 0; $i -lt $labels.Count; $i++) {
        $t = $labels.Item($i)
        if ($t.Current.Name -match '文件名|File name') {
            $r = $t.Current.BoundingRectangle
            $editX = [int]($r.X + 300)
            $editY = [int]($r.Y + $r.Height / 2)
            Write-Host ("  file name label at {0},{1}" -f [int]$r.X, [int]$r.Y)
            break
        }
    }

    if ($editX -eq 0) {
        # 最后手段：对话框底部的编辑框（在「打开」按钮左侧一整条）
        $r = $dlg.Current.BoundingRectangle
        $editX = [int]($r.X + $r.Width / 2)
        $editY = [int]($r.Y + $r.Height - 60)
        Write-Host '  file name label not found - using dialog geometry.'
    }

    [System.Windows.Forms.Clipboard]::SetText($PenFile)
    Start-Sleep -Milliseconds 400

    Click-At -X $editX -Y $editY
    Start-Sleep -Milliseconds 700
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait('{DEL}')
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 900
    # kill the shell's inline auto-complete suffix ("...home.penhome.pen")
    [System.Windows.Forms.SendKeys]::SendWait('{DEL}')
    Start-Sleep -Milliseconds 700
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

    Start-Sleep -Seconds 6
}
}

# ---- 4. maximize -------------------------------------------------------------
$handle = Get-PenWindow
if ($handle -ne [IntPtr]::Zero) {
    [PenOpen.Native]::ShowWindow($handle, 3) | Out-Null   # SW_MAXIMIZE
    Start-Sleep -Milliseconds 800
    [PenOpen.Native]::SetForegroundWindow($handle) | Out-Null
}

Write-Host 'Done.'
