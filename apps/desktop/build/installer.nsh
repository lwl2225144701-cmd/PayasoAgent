; 插入点由 scripts/package-windows.mjs 锁定；helper 独立于被替换的应用。
!include LogicLib.nsh
!ifndef BUILD_UNINSTALLER
Var payasoUpdateState
Var payasoUpdateHelper

!macro payasoPrepareUpdate
  InitPluginsDir
  File /oname=$PLUGINSDIR\PayasoUpdate.exe "${BUILD_RESOURCES_DIR}\PayasoUpdate.exe"
  StrCpy $payasoUpdateHelper "$PLUGINSDIR\PayasoUpdate.exe"
  StrCpy $payasoUpdateState "$PLUGINSDIR\payaso-update.json"
  StrCpy $R8 "$newDesktopLink"
  ${if} ${isNoDesktopShortcut}
    StrCpy $R8 "-"
  ${endIf}
  ClearErrors
  ExecWait '"$payasoUpdateHelper" prepare "$payasoUpdateState" "$appExe" "$R8" "$newStartMenuLink"' $R9
  ${if} ${Errors}
  ${orIf} $R9 != 0
    Abort "Cannot prepare Windows update. See PayasoAgent logs/windows-install.log."
  ${endIf}
!macroend

!macro customInstall
  ${ifNot} ${FileExists} "$appExe"
    Abort "Updated application executable is missing: $appExe"
  ${endIf}
  ClearErrors
  ExecWait '"$payasoUpdateHelper" finish "$payasoUpdateState" "$appExe"' $R9
  ${if} ${Errors}
  ${orIf} $R9 != 0
    DetailPrint "Shortcut verification failed; see windows-install.log"
  ${endIf}
!macroend

!macro payasoStartVerifiedApp
  HideWindow
  ClearErrors
  ExecWait '"$payasoUpdateHelper" launch "$appExe" "${VERSION}"' $R9
  ${if} ${Errors}
  ${orIf} $R9 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "PayasoAgent is installed, but automatic restart was not confirmed. See logs/windows-install.log."
    SetErrorLevel 2
    Quit
  ${endIf}
  ClearErrors
  ExecWait '"$payasoUpdateHelper" finish "$payasoUpdateState" "$appExe"' $R9
  ${if} ${Errors}
  ${orIf} $R9 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "PayasoAgent has restarted, but shortcut verification failed. See logs/windows-install.log."
    SetErrorLevel 2
    Quit
  ${endIf}
!macroend

Function .onInstFailed
  ${if} ${FileExists} "$payasoUpdateState"
    ExecWait '"$payasoUpdateHelper" restore "$payasoUpdateState"' $R9
  ${endIf}
FunctionEnd

Function .onUserAbort
  ${if} ${FileExists} "$payasoUpdateState"
    ExecWait '"$payasoUpdateHelper" restore "$payasoUpdateState"' $R9
  ${endIf}
FunctionEnd
!endif
