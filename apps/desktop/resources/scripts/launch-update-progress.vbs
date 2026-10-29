' launch-update-progress.vbs
' 隐藏中继：启动 update-progress.ps1 的过渡窗，且不闪任何控制台/黑窗。
'
' 为什么必须是 VBS 而不是 `cmd /c start powershell ...`：
'   - `cmd /c start` 经由 cmd 的 start 内建命令拉起 PowerShell，会分配一个
'     conhost/控制台 —— 加载窗出现前会先闪一下黑色终端（windowsHide 只能藏住
'     直接 spawn 的 cmd.exe，藏不住 start 内部创建的那个控制台）。
'   - 直接用 detached  spawn powershell.exe 会剥掉它的控制台，导致 PowerShell
'     还没跑脚本就退出；不 detached 又没法保证窗口比 Electron 主进程活得更久。
'   - wscript.exe 是 GUI 子系统宿主（根本没有控制台），WshShell.Run(cmd, 0, False)
'     以隐藏窗口启动 PowerShell 并立即返回，所以 PowerShell 能在父进程
'     （Electron 主进程）退出后继续独立运行。没有 conhost，没有闪黑。
'
' 用法（由 src/update/windows-installer.ts 在安装器启动前调用）：
'   wscript.exe launch-update-progress.vbs <ps1Path> [powershell 参数...]
' 参数 0 是 .ps1 路径，其余原样转交给 powershell.exe -File <ps1Path>。

Option Explicit

Dim shell, args, i, ps1Path, forwarded, cmd

If WScript.Arguments.Count < 1 Then
    ' 没有可启动的对象；过渡窗只是体验增强，静默返回而不是报错。
    WScript.Quit 0
End If

Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments

ps1Path = args(0)

' 重建转交参数表，逐个加引号，保证带空格的路径和文案不被打断。
' 跳过参数 0（.ps1 路径，由下面的 -File 处理）。
forwarded = ""
For i = 1 To args.Count - 1
    forwarded = forwarded & " " & Quote(args(i))
Next

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " _
    & Quote(ps1Path) & forwarded

' 0 = 隐藏窗口，False = 不等待（立即返回，PowerShell 才能在本中继和
' Electron 主进程都退出之后继续跑）。
shell.Run cmd, 0, False

WScript.Quit 0

' 给值包一层双引号，内部的双引号按 VBScript/命令行惯例翻倍转义。
Function Quote(value)
    Quote = """" & Replace(value, """", """""") & """"
End Function
