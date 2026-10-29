; 更新完成后，把桌面和开始菜单快捷方式指回刚装好的 exe。
;
; electron-builder 在 KeepShortcuts=true 且旧 exe 还在时不会改 .lnk。
; 卸载却会先把安装目录里的文件改名挪进临时目录，再整目录删掉（un.atomicRMDir）。
; 资源管理器的链接跟踪盯着桌面快捷方式，会把目标改成那个临时路径；开始菜单快捷方式通常仍指向原路径。
; 临时目录随后被删掉，桌面图标变成失效图标。再点一次，Windows 就提示目标已更改或移动，并删掉这个快捷方式。
; 这里等新文件写回 $INSTDIR 之后重写两条快捷方式。只在 --updated 时做，首次安装仍走 addDesktopLink。

; 单独留安装器诊断，避免静默更新把快捷方式写入失败吞掉。
!macro payasoShortcutLog message
  Push $R9
  ClearErrors
  FileOpen $R9 "$INSTDIR\shortcut-repair.log" a
  ${ifNot} ${Errors}
    FileWrite $R9 "${message}$\r$\n"
    FileClose $R9
  ${endIf}
  Pop $R9
  ClearErrors
!macroend

!macro customInstall
  ${if} ${isUpdated}
    ${ifNot} ${FileExists} "$appExe"
      Abort "Updated application executable is missing: $appExe"
    ${endIf}
    ; 自动重启直接使用已安装 EXE，不能依赖可能失效的开始菜单链接。
    StrCpy $launchLink "$appExe"
    ClearErrors
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ${if} ${Errors}
      !insertmacro payasoShortcutLog "Desktop shortcut creation failed: $newDesktopLink -> $appExe"
    ${endIf}
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${if} ${Errors}
      !insertmacro payasoShortcutLog "Desktop shortcut identity failed: $newDesktopLink"
    ${endIf}
    ClearErrors
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ${if} ${Errors}
      !insertmacro payasoShortcutLog "Start menu shortcut creation failed: $newStartMenuLink -> $appExe"
    ${endIf}
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${if} ${Errors}
      !insertmacro payasoShortcutLog "Start menu shortcut identity failed: $newStartMenuLink"
    ${endIf}
    ClearErrors
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${endIf}
!macroend
