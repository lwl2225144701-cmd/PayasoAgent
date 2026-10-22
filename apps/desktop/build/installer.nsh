; 更新完成后，把桌面和开始菜单快捷方式指回刚装好的 exe。
;
; electron-builder 在 KeepShortcuts=true 且旧 exe 还在时不会改 .lnk。
; 卸载却会先把安装目录里的文件改名挪进临时目录，再整目录删掉（un.atomicRMDir）。
; 资源管理器的链接跟踪盯着桌面快捷方式，会把目标改成那个临时路径；开始菜单快捷方式通常仍指向原路径。
; 临时目录随后被删掉，桌面图标变成失效图标。再点一次，Windows 就提示目标已更改或移动，并删掉这个快捷方式。
; 这里等新文件写回 $INSTDIR 之后重写两条快捷方式。只在 --updated 时做，首次安装仍走 addDesktopLink。

!macro customInstall
  ${if} ${isUpdated}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ClearErrors
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ClearErrors
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${endIf}
!macroend
