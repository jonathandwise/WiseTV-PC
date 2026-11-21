; WiseTV installer: per-user install (no administrator rights needed), Start menu and desktop shortcuts.
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "MUI2.nsh"

Name "WiseTV"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\WiseTV"
InstallDirRegKey HKCU "Software\WiseTV" "InstallDir"
BrandingText "WiseTV ${VERSION}"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\WiseTV.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start WiseTV"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "WiseTV"
VIAddVersionKey "FileDescription" "WiseTV installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "WiseTV"

Function CloseRunning
  ; Close a running copy so its files can be replaced.
  nsExec::Exec 'taskkill /IM WiseTV.exe /F /T'
  Sleep 800
FunctionEnd

Section "WiseTV" SecMain
  Call CloseRunning
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall WiseTV.exe"
  CreateShortcut "$SMPROGRAMS\WiseTV.lnk" "$INSTDIR\WiseTV.exe"
  CreateShortcut "$DESKTOP\WiseTV.lnk" "$INSTDIR\WiseTV.exe"
  WriteRegStr HKCU "Software\WiseTV" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiseTV" "DisplayName" "WiseTV"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiseTV" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiseTV" "Publisher" "WiseTV"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiseTV" "DisplayIcon" "$INSTDIR\WiseTV.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiseTV" "UninstallString" '"$INSTDIR\Uninstall WiseTV.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiseTV" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiseTV" "NoRepair" 1
  ; An automatic update runs silently: start WiseTV again when it's done.
  IfSilent 0 +2
    Exec '"$INSTDIR\WiseTV.exe"'
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM WiseTV.exe /F /T'
  Sleep 800
  Delete "$SMPROGRAMS\WiseTV.lnk"
  Delete "$DESKTOP\WiseTV.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiseTV"
  DeleteRegKey HKCU "Software\WiseTV"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WiseTV"
  ; Settings, guide data and recordings are kept (in %APPDATA%\WiseTV and Videos\WiseTV).
SectionEnd
