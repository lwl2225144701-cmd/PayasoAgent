# 安装器启动前的过渡窗（Windows）。
#
# 背景（v0.4.23 实机验收，2026-10-29）：静默 NSIS 安装在自己电脑上要 3 分 48 秒。
# 这期间 Electron 已经退出、桌面图标在位、屏幕上没有任何反馈，用户等不到 1 分钟
# 就认定更新失败并手动启动——手动启动也成功，于是"自动重启"被记成"没生效"。
# 本脚本就是补上这段可见状态：退出前先弹出它，新应用主窗口一出现就自动关闭。
#
# 由 launch-update-progress.vbs 隐藏中继启动（wscript 是 GUI 子系统，不会闪控制台），
# 因此它能在 Electron 主进程退出后继续存活。
#
# 关闭条件（先到先得）：
#   1) 新应用进程出现可见主窗口 —— 新版本真的就绪了，立刻关。
#   2) 安装器进程消失且已过淡出间隔 —— 安装结束的兜底。
#   3) -TimeoutSeconds 内始终没见过安装器 —— 安装器没起来的防御。
#   4) -MaxInstallSeconds 绝对上限 —— 安装器挂死的防御。
#
# 第 2 条绝不能提前：安装器还在跑就关窗，用户会以为装完了手动启动，而 NSIS
# 正在覆写 app.asar（WorkBuddy 同款问题，issue #135544）。

param(
    [string]$InstallerPath = "",
    [string]$AppProcessName = "",
    [int]$OldAppProcessId = 0,
    [string]$Title = "正在安装更新",
    [string]$Message = "更新即将完成，应用将自动重启，请稍候...",
    [string]$Caption = "正在安装...",
    [int]$TimeoutSeconds = 120,
    [int]$MaxInstallSeconds = 600,
    # 窗口出现后先等这么久再开始轮询安装器：避免 NSIS 还没被拉起时
    # Get-Process 返回空，被误判成"安装器已经结束"。
    [int]$DetectStartSeconds = 3,
    # 安装器进程消失后继续显示这么久，给新应用主窗口留出绘制和接管焦点的时间。
    [int]$FadeMs = 3000
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

# 按进程名匹配比每轮重新扫路径便宜得多。
$installerName = if ($InstallerPath) {
    [System.IO.Path]::GetFileNameWithoutExtension($InstallerPath)
} else {
    ""
}

function Test-NewAppWindowReady {
    if (-not $AppProcessName) {
        return $false
    }
    try {
        $readyApp = Get-Process -Name $AppProcessName -ErrorAction SilentlyContinue |
            Where-Object { $_.Id -ne $OldAppProcessId -and $_.MainWindowHandle -ne [IntPtr]::Zero } |
            Select-Object -First 1
        return $null -ne $readyApp
    } catch {
        return $false
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
# 无边框：标题栏只留一个最小化按钮，32px 高度替代原生标题栏。
$form.ClientSize = New-Object System.Drawing.Size(420, 232)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "None"
$form.ControlBox = $false
# 无边框窗口露出的 1px 背景就是窗口边框。
$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#b7bec8")
$form.ShowInTaskbar = $true
$form.TopMost = $false

# 图标：优先从应用 EXE 取，其次 resources/icon.ico，最后退化成无图标。
# 打包后本脚本位于 resources/scripts/，icon.ico 位于 resources/。
$iconCandidates = @(
    (Join-Path (Split-Path -Parent $PSScriptRoot) 'icon.ico')
    (Join-Path $PSScriptRoot 'icon.ico')
)
$windowIcon = $null
foreach ($candidate in $iconCandidates) {
    if (-not [System.IO.File]::Exists($candidate)) { continue }
    try {
        $windowIcon = [System.Drawing.Icon]::new($candidate, 32, 32)
        $form.Icon = $windowIcon
        break
    } catch {
        # 安装器可能已经替换过该资源。
        if ($windowIcon) { $windowIcon.Dispose(); $windowIcon = $null }
    }
}

$headerPanel = New-Object System.Windows.Forms.Panel
$headerPanel.Size = New-Object System.Drawing.Size(418, 32)
$headerPanel.Location = New-Object System.Drawing.Point(1, 1)
$headerPanel.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#f9fafb")

$headerTitle = New-Object System.Windows.Forms.Label
$headerTitle.Text = $Title
$headerTitle.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$headerTitle.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#111827")
$headerTitle.AutoSize = $false
$headerTitle.Size = New-Object System.Drawing.Size(360, 32)
$headerTitle.Location = New-Object System.Drawing.Point(12, 0)
$headerTitle.TextAlign = "MiddleLeft"
$headerPanel.Controls.Add($headerTitle)

$minimizeButton = New-Object System.Windows.Forms.Label
$minimizeButton.Text = [char]0x2500
$minimizeButton.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$minimizeButton.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#6b7280")
$minimizeButton.AutoSize = $false
$minimizeButton.Size = New-Object System.Drawing.Size(40, 32)
$minimizeButton.Location = New-Object System.Drawing.Point(378, 0)
$minimizeButton.TextAlign = "MiddleCenter"
$minimizeButton.Cursor = [System.Windows.Forms.Cursors]::Hand
$minimizeButton.Add_Click({ $form.WindowState = "Minimized" })
$minimizeButton.Add_MouseEnter({ $minimizeButton.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#e5e7eb") })
$minimizeButton.Add_MouseLeave({ $minimizeButton.BackColor = $headerPanel.BackColor })
$headerPanel.Controls.Add($minimizeButton)
$form.Controls.Add($headerPanel)

# WinForms 子控件的鼠标事件不会冒泡到面板，拖动处理器要同时挂空白栏和标题，
# 但保持最小化按钮可点。
$script:dragging = $false
$startDrag = {
    param($sender, $eventArgs)
    if ($eventArgs.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
    $script:dragging = $true
    $script:dragCursor = [System.Windows.Forms.Control]::MousePosition
    $script:dragOrigin = $form.Location
}
$moveDrag = {
    if (-not $script:dragging) { return }
    if (-not ([System.Windows.Forms.Control]::MouseButtons -band [System.Windows.Forms.MouseButtons]::Left)) {
        $script:dragging = $false
        return
    }
    $cursor = [System.Windows.Forms.Control]::MousePosition
    $newX = $script:dragOrigin.X + $cursor.X - $script:dragCursor.X
    $newY = $script:dragOrigin.Y + $cursor.Y - $script:dragCursor.Y
    $form.Location = [System.Drawing.Point]::new($newX, $newY)
}
$endDrag = { $script:dragging = $false }
$headerPanel.Add_MouseDown($startDrag)
$headerPanel.Add_MouseMove($moveDrag)
$headerPanel.Add_MouseUp($endDrag)
$headerTitle.Add_MouseDown($startDrag)
$headerTitle.Add_MouseMove($moveDrag)
$headerTitle.Add_MouseUp($endDrag)

$separatorPanel = New-Object System.Windows.Forms.Panel
$separatorPanel.Size = New-Object System.Drawing.Size(418, 1)
$separatorPanel.Location = New-Object System.Drawing.Point(1, 33)
$separatorPanel.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#e5e7eb")
$form.Controls.Add($separatorPanel)

$bodyPanel = New-Object System.Windows.Forms.Panel
$bodyPanel.Size = New-Object System.Drawing.Size(418, 197)
$bodyPanel.Location = New-Object System.Drawing.Point(1, 34)
$bodyPanel.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($bodyPanel)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = $Title
$titleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 16, [System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#111827")
$titleLabel.AutoSize = $false
$titleLabel.Size = New-Object System.Drawing.Size(380, 36)
$titleLabel.Location = New-Object System.Drawing.Point(20, 30)
$titleLabel.TextAlign = "MiddleCenter"
$bodyPanel.Controls.Add($titleLabel)

$msgLabel = New-Object System.Windows.Forms.Label
$msgLabel.Text = $Message
$msgLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$msgLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#6b7280")
$msgLabel.AutoSize = $false
$msgLabel.Size = New-Object System.Drawing.Size(380, 40)
$msgLabel.Location = New-Object System.Drawing.Point(20, 72)
$msgLabel.TextAlign = "MiddleCenter"
$bodyPanel.Controls.Add($msgLabel)

$progressBar = New-Object System.Windows.Forms.ProgressBar
$progressBar.Style = "Marquee"
$progressBar.MarqueeAnimationSpeed = 30
$progressBar.Size = New-Object System.Drawing.Size(380, 8)
$progressBar.Location = New-Object System.Drawing.Point(20, 130)
$bodyPanel.Controls.Add($progressBar)

$captionLabel = New-Object System.Windows.Forms.Label
$captionLabel.Text = $Caption
$captionLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$captionLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#9ca3af")
$captionLabel.AutoSize = $false
$captionLabel.Size = New-Object System.Drawing.Size(380, 24)
$captionLabel.Location = New-Object System.Drawing.Point(20, 148)
$captionLabel.TextAlign = "MiddleCenter"
$bodyPanel.Controls.Add($captionLabel)

$script:startTime = [DateTime]::Now
$script:installerSeen = $false  # 观察到安装器在跑后置真
$script:closing = $false        # 防重入

# Form.Close() 也会报 UserClosing，用标记区分定时器驱动的关闭；同时挡住 Alt+F4。
$form.Add_FormClosing({
    param($sender, $eventArgs)
    if ($eventArgs.CloseReason -eq [System.Windows.Forms.CloseReason]::UserClosing -and -not $script:closing) {
        $eventArgs.Cancel = $true
    }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000

$timer.Add_Tick({
    if ($script:closing) { return }
    $elapsed = ([DateTime]::Now - $script:startTime).TotalSeconds

    # 绝对上限：安装器挂死时窗口不会永远留着。
    if ($elapsed -ge $MaxInstallSeconds) {
        $script:closing = $true
        $timer.Stop()
        $form.Close()
        return
    }

    # 从没见过安装器 —— 它没起来，别再等。一旦见过，就只有它退出（或上面的上限）能关窗。
    if (-not $script:installerSeen -and $elapsed -ge $TimeoutSeconds) {
        $script:closing = $true
        $timer.Stop()
        $form.Close()
        return
    }

    # 新应用主窗口一可见就关，与安装器轮询解耦，不必等检测宽限期。
    if (Test-NewAppWindowReady) {
        $script:closing = $true
        $timer.Stop()
        $form.Close()
        return
    }

    # 宽限期内不轮询安装器，避免和"NSIS 还没被拉起"竞态。
    if ($elapsed -lt $DetectStartSeconds) {
        return
    }

    # 调用方没给安装器路径就没得轮询，退回硬超时。
    if (-not $installerName) {
        return
    }

    $running = Get-Process -Name $installerName -ErrorAction SilentlyContinue
    if ($running) {
        # 安装器在干活，继续显示。
        $script:installerSeen = $true
        return
    }

    if (-not $script:installerSeen) {
        # 可能正处在窗口出现到 NSIS 真正启动之间的空隙，再等一个滴答。
        return
    }

    # 安装器从有到无 —— 装完了。多留一会让新应用主窗口画完并接管焦点。
    $script:closing = $true
    Start-Sleep -Milliseconds $FadeMs
    $timer.Stop()
    $form.Close()
})

$timer.Start()
# 父进程退出后仍要保持消息循环，但不能让窗口变成模态。
try {
    [System.Windows.Forms.Application]::Run($form)
} finally {
    if ($windowIcon) { $windowIcon.Dispose() }
}
