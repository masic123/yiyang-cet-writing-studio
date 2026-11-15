Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
Name "译洋"
!ifndef APP_VERSION
  !error "Build with build.py so both installers share the release version"
!endif
OutFile "..\dist\yiyang-${APP_VERSION}-windows-x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Yiyang"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "译洋 · 四六级写作与翻译"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "译洋"
VIAddVersionKey /LANG=2052 "FileDescription" "译洋安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "译洋"
!define MUI_ICON "app.ico"
!define MUI_UNICON "app.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "欢迎安装译洋"
!define MUI_WELCOMEPAGE_TEXT "四级与六级写作、翻译练习。$\r$\n$\r$\n安装后使用现有译洋账号登录。客户端需要联网使用。$\r$\n$\r$\n本程序会为当前用户安装，无需管理员权限。若电脑缺少 WebView2，将安装微软官方运行时。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\Yiyang.exe"
!define MUI_FINISHPAGE_RUN_TEXT "打开译洋"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "译洋需要 64 位 Windows 10 或 Windows 11。"
    Abort
  ${EndIf}
  check_running_client:
  FindWindow $0 "" "译洋 · 四六级写作与翻译"
  ${If} $0 != 0
    IfSilent abort_running_client
    MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "请先保存练习并关闭已打开的译洋客户端，再点击重试。" IDRETRY check_running_client
    abort_running_client:
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd
Section "译洋" Main
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File "bin\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\译洋"
  CreateShortcut "$SMPROGRAMS\译洋\译洋.lnk" "$INSTDIR\Yiyang.exe"
  CreateShortcut "$SMPROGRAMS\译洋\卸载译洋.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\译洋.lnk" "$INSTDIR\Yiyang.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Yiyang" "DisplayName" "译洋"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Yiyang" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Yiyang" "Publisher" "译洋"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Yiyang" "DisplayIcon" "$INSTDIR\Yiyang.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Yiyang" "URLInfoAbout" "https://yiyangcet.xyz/"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Yiyang" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Yiyang" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Yiyang" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Yiyang" "NoRepair" 1
  ; Evergreen runtime may be installed either per-user or per-machine.
  ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    SetRegView 32
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "..\tools\MicrosoftEdgeWebview2Setup.exe"
    DetailPrint "正在安装 Microsoft Edge WebView2…"
    ExecWait '$\"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe$\" /silent /install' $1
    ${If} $1 != 0
      MessageBox MB_OK|MB_ICONINFORMATION "WebView2 未安装完成。请联网后通过微软官网安装 WebView2，再打开译洋。"
    ${EndIf}
  ${EndIf}
SectionEnd
Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\译洋.lnk"
  Delete "$SMPROGRAMS\译洋\译洋.lnk"
  Delete "$SMPROGRAMS\译洋\卸载译洋.lnk"
  RMDir "$SMPROGRAMS\译洋"
  Delete "$INSTDIR\Yiyang.exe"
  Delete "$INSTDIR\Yiyang.exe.config"
  Delete "$INSTDIR\Microsoft.Web.WebView2.Core.dll"
  Delete "$INSTDIR\Microsoft.Web.WebView2.WinForms.dll"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\app.ico"
  Delete "$INSTDIR\WebView2-LICENSE.txt"
  Delete "$INSTDIR\WebView2-ThirdPartyNotices.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Yiyang"
  ; Keep the profile and login cookies for reinstallations. Never remove unrelated user files.
SectionEnd
