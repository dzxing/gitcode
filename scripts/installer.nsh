!include "LogicLib.nsh"

!macro customCheckAppRunning
  Push $R0
  Push $R1
  InitPluginsDir
  File /oname=$PLUGINSDIR\gitcode-installer-processes.ps1 "${PROJECT_DIR}\scripts\installer-processes.ps1"
  File /oname=$PLUGINSDIR\gitcode-installer-launcher.exe "${PROJECT_DIR}\.gitcode-local\installer\gitcode-installer-launcher.exe"
  ClearErrors
  StrCpy $R0 "error"
  ${If} ${Silent}
    ExecWait '"$PLUGINSDIR\gitcode-installer-launcher.exe" "$PLUGINSDIR\gitcode-installer-processes.ps1" "$INSTDIR" "${APP_EXECUTABLE_FILENAME}" silent' $R0
  ${Else}
    ExecWait '"$PLUGINSDIR\gitcode-installer-launcher.exe" "$PLUGINSDIR\gitcode-installer-processes.ps1" "$INSTDIR" "${APP_EXECUTABLE_FILENAME}"' $R0
  ${EndIf}
  ${If} ${Errors}
    StrCpy $R0 "error"
  ${EndIf}
  ${If} $R0 != 0
    ${If} $R0 != 2
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "无法检查或关闭旧版本，安装尚未开始。请检查运行权限后重试。"
      ${EndIf}
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend
