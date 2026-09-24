; ============================================================================
; 自定义「关闭正在运行的应用」逻辑（customCheckAppRunning）—— v1.1.6 修复
;
; 背景：
; electron-builder 默认实现按 $INSTDIR 路径前缀匹配进程（PowerShell 管线
; Get-CimInstance | ? { $_.Path.StartsWith('$INSTDIR') }），而本应用的安装包
; 恰好存放在 安装目录\软件更新\ 内，路径同样以 $INSTDIR 开头——关闭阶段会把
; 「安装器自己」也一并匹配进去：
;   - 温和关闭阶段向安装器向导发送 WM_CLOSE，向导直接消失（用户看到
;     「软件关闭的同时安装程序也被关闭」）；
;   - 强制阶段 TerminateProcess 自身，安装中断、$TEMP 下 ns*.tmp 残留。
; 同时本应用服务端模式下「点关闭 = 隐藏到托盘」，默认逻辑实际关不掉，
; 只能反复强杀，失败时卡在「无法关闭」重试循环。
;
; 本文件做两件事：
;   1) customInit：安装器若位于旧版安装目录内，先复制自身到 %TEMP% 并从那里
;      重新启动（脱离旧版卸载器 ≤v1.1.5 同款路径前缀检查的匹配范围，否则
;      升级时旧卸载器会把新安装器一起杀掉，旧文件被卸、新文件未装）。
;   2) customCheckAppRunning：按进程名精确匹配（tasklist/taskkill），只针对
;      应用可执行文件，绝不触碰安装器/卸载器自身；温和关闭失败再逐级强制。
; ============================================================================

!ifndef XQY_CUSTOM_CHECK_APP_RUNNING_INCLUDED
!define XQY_CUSTOM_CHECK_APP_RUNNING_INCLUDED

; ----------------------------------------------------------------------------
; 自保护：从“…\软件更新”目录内启动时，改从 %TEMP% 重启（保留原文件名，
; 便于应用侧“协同退出”监视器按文件名识别；也脱离旧版卸载器的路径匹配范围）。
; 不解析注册表，直接用本产品固定的更新目录名判定。
; ----------------------------------------------------------------------------
!macro customInit
  StrLen $R0 "$EXEDIR"
  ${If} $R0 > 5
    StrCpy $R1 "$EXEDIR" 5 -5       ; 取末 5 字符：“\软件更新”
    ${If} $R1 == "\软件更新"
      CopyFiles /SILENT "$EXEPATH" "$TEMP\$EXEFILE"
      ${If} ${FileExists} "$TEMP\$EXEFILE"
        Exec '"$TEMP\$EXEFILE"'
        Quit
      ${endIf}
    ${endIf}
  ${endIf}
!macroend

; ----------------------------------------------------------------------------
; 按进程名查找（沿用 electron-builder 模板同款 findstr 锚定行首精确匹配管道）
; ----------------------------------------------------------------------------
!macro XQY_FIND_BY_NAME _FILE _RETURN
  nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${_FILE}" /FI "USERNAME eq %USERNAME%" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${_FILE}\""`
  Pop ${_RETURN}
!macroend

!macro customCheckAppRunning
  !insertmacro XQY_FIND_BY_NAME "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    ; 非升级流程（isUpdated 仅在应用内升级器拉起安装器时为真）先征求用户同意
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK xqy_doStop
      Quit
      xqy_doStop:
    ${endIf}
    DetailPrint "$(appClosing)"

    ; 第一轮：温和关闭（不带 /F，发送 WM_CLOSE；软件侧检测到安装器会主动真正退出）
    nsExec::Exec `"$CmdPath" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
    Pop $R1
    Sleep 1500
    !insertmacro XQY_FIND_BY_NAME "${APP_EXECUTABLE_FILENAME}" $R0

    ; 仍在运行 → 第二轮：强制结束（含子进程树）
    ${if} $R0 == 0
      nsExec::Exec `"$CmdPath" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
      Pop $R1
      Sleep 1500
      !insertmacro XQY_FIND_BY_NAME "${APP_EXECUTABLE_FILENAME}" $R0
    ${endIf}

    ; 仍在运行 → 第三轮：再次强制结束并给系统更多时间
    ${if} $R0 == 0
      nsExec::Exec `"$CmdPath" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
      Pop $R1
      Sleep 2500
      !insertmacro XQY_FIND_BY_NAME "${APP_EXECUTABLE_FILENAME}" $R0
    ${endIf}

    ; 仍无法结束：交给用户手动处理（例如托盘图标右键退出），可反复重试
    ${if} $R0 == 0
      xqy_askRetry:
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY xqy_forceAgain
      Quit
      xqy_forceAgain:
      nsExec::Exec `"$CmdPath" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
      Pop $R1
      Sleep 2000
      !insertmacro XQY_FIND_BY_NAME "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        Goto xqy_askRetry
      ${endIf}
    ${endIf}
  ${endIf}
!macroend

!endif
