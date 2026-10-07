; Alfred installer for Windows x64 (specs/012-server-program, contracts/installer-and-build.md).
; Built by build_dist.py:  makensis -DVERSION=... -DVERSION_NUMERIC=a.b.c.d -DSTAGE=<stage folder> -DOUTFILE=<exe>
;
; Wizard: folder and UI port. Silent:
;   alfred-setup-<version>-windows-x64.exe /S [/DIR=C:\alfred] [/UIPORT=3000] [/SERVICEUSER=LocalSystem]
;                                             [/IMPORTDOCKER=<folder>] [/ALLOWDOWNGRADE]
; Exit codes: 0 ok, 1 failed, 5 not an administrator, 6 refused downgrade.

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel admin
ManifestSupportedOS all

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "TextFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define APP "Alfred"
!define SERVICE_EXE "$INSTDIR\service\alfred-service.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Alfred"
!define ENV_KEY "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"

Name "${APP} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "C:\alfred"
VIProductVersion "${VERSION_NUMERIC}"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION_NUMERIC}"
VIAddVersionKey "FileDescription" "${APP} setup"
VIAddVersionKey "LegalCopyright" "Alfred"

Var UiPort
Var ServiceUser
Var ImportFrom
Var AllowDowngrade
Var PortField

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
Page custom PortPage PortPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  UserInfo::GetAccountType
  Pop $0
  ${If} $0 != "admin"
    IfSilent +2
      MessageBox MB_ICONSTOP "Alfred installs a Windows service: run the setup as an administrator."
    SetErrorLevel 5
    Quit
  ${EndIf}
  ${GetParameters} $R0
  StrCpy $UiPort ""
  StrCpy $ServiceUser "LocalSystem"
  StrCpy $ImportFrom ""
  StrCpy $AllowDowngrade "0"
  ClearErrors
  ${GetOptions} $R0 "/UIPORT=" $1
  ${IfNot} ${Errors}
    StrCpy $UiPort $1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/SERVICEUSER=" $1
  ${IfNot} ${Errors}
    StrCpy $ServiceUser $1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/IMPORTDOCKER=" $1
  ${IfNot} ${Errors}
    StrCpy $ImportFrom $1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/ALLOWDOWNGRADE" $1
  ${IfNot} ${Errors}
    StrCpy $AllowDowngrade "1"
  ${EndIf}
  ReadRegStr $1 HKLM "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $1 != ""
    StrCpy $INSTDIR $1
  ${EndIf}
FunctionEnd

Function PortPage
  !insertmacro MUI_HEADER_TEXT "Web UI port" "The one port for the UI, the API and Claude's tools."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "Alfred's UI will be at http://localhost:<port>. Leave 3000 unless that port is taken."
  Pop $0
  ${If} $UiPort == ""
    StrCpy $UiPort "3000"
  ${EndIf}
  ${NSD_CreateText} 0 30u 60u 12u $UiPort
  Pop $PortField
  nsDialogs::Show
FunctionEnd

Function PortPageLeave
  ${NSD_GetText} $PortField $UiPort
FunctionEnd

Section "Alfred" SecMain
  SetShellVarContext all
  ; ---- upgrade check ------------------------------------------------------------------------------------------------
  ${If} ${FileExists} "$INSTDIR\app\VERSION"
    FileOpen $0 "$INSTDIR\app\VERSION" r
    FileRead $0 $1
    FileClose $0
    ${TrimNewLines} $1 $1
    ${If} $1 != "${VERSION}"
      ${VersionCompare} "$1" "${VERSION}" $2
      ${If} $2 == "1"
      ${AndIf} $AllowDowngrade != "1"
        IfSilent +2
          MessageBox MB_ICONSTOP "Installed version $1 is newer than ${VERSION}. Run with /ALLOWDOWNGRADE to install it anyway."
        SetErrorLevel 6
        Quit
      ${EndIf}
      DetailPrint "Upgrading $1 -> ${VERSION} (settings and recorded data are kept)"
    ${EndIf}
    ${If} ${FileExists} "${SERVICE_EXE}"
      nsExec::ExecToLog '"${SERVICE_EXE}" stop'
      Pop $0
    ${EndIf}
    RMDir /r "$INSTDIR\runtime"
    RMDir /r "$INSTDIR\app"
  ${EndIf}

  ; ---- program files: everything in the stage; .env and data\ are never part of it ---------------------------------
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"
  CreateDirectory "$INSTDIR\data\log"
  DetailPrint "Program files in $INSTDIR"

  ; ---- settings: .env created once, by the Java settings engine -----------------------------------------------------
  ${IfNot} ${FileExists} "$INSTDIR\.env"
    nsExec::ExecToLog '"$INSTDIR\alfred.cmd" _init-env'
    Pop $0
  ${EndIf}
  ${If} $UiPort != ""
  ${AndIf} $UiPort != "3000"
    nsExec::ExecToLog '"$INSTDIR\alfred.cmd" config set ALFRED_UI_PORT $UiPort'
    Pop $0
  ${EndIf}

  ; ---- Docker import (FR-002d): asked in the wizard, only with /IMPORTDOCKER= when silent --------------------------
  ${If} $ImportFrom == ""
  ${AndIfNot} ${Silent}
    nsExec::ExecToStack '"$INSTDIR\runtime\python\python.exe" "$INSTDIR\app\launcher\docker_import.py" --detect'
    Pop $0
    Pop $1
    ${TrimNewLines} $1 $1
    ${If} $0 == "0"
    ${AndIf} $1 != ""
      MessageBox MB_YESNO|MB_ICONQUESTION "Import settings and recorded data from the Docker install in $1?$\r$\nThe Docker folder is not changed; its containers are stopped after a successful copy." IDNO +2
        StrCpy $ImportFrom $1
    ${EndIf}
  ${EndIf}
  ${If} $ImportFrom != ""
    nsExec::ExecToLog '"$INSTDIR\runtime\python\python.exe" "$INSTDIR\app\launcher\docker_import.py" --home "$INSTDIR" --from "$ImportFrom"'
    Pop $0
    ${If} $0 != "0"
      DetailPrint "Docker import failed - continuing with an empty install; the Docker install is unchanged."
    ${EndIf}
  ${EndIf}

  ; ---- owner-only data and secrets ----------------------------------------------------------------------------------
  nsExec::ExecToLog 'icacls "$INSTDIR\data" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F /grant:r *S-1-5-32-544:(OI)(CI)F'
  Pop $0
  nsExec::ExecToLog 'icacls "$INSTDIR\.env" /inheritance:r /grant:r *S-1-5-18:F /grant:r *S-1-5-32-544:F'
  Pop $0

  ; ---- the "alfred" command on the machine PATH ---------------------------------------------------------------------
  ReadRegStr $0 HKLM "${ENV_KEY}" "Path"
  ClearErrors
  ${WordFind} "$0" "$INSTDIR" "E+1{" $1
  ${If} ${Errors}
    WriteRegExpandStr HKLM "${ENV_KEY}" "Path" "$0;$INSTDIR"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}

  ; ---- service (LocalSystem; another account is set afterwards in services.msc - WinSW needs its password) ----------
  ${If} $ServiceUser != "LocalSystem"
    DetailPrint "Service account $ServiceUser: set it in services.msc (Alfred > Log On); installing as LocalSystem."
  ${EndIf}
  nsExec::ExecToLog '"${SERVICE_EXE}" install'
  Pop $0
  nsExec::ExecToLog '"${SERVICE_EXE}" start'
  Pop $0
  DetailPrint "Service $\"alfred$\" installed and started (starts at boot)"

  ; ---- uninstaller ---------------------------------------------------------------------------------------------------
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "Alfred"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
  DetailPrint "Next: 'alfred status', 'alfred jvms', 'alfred attach <pid>'. UI: http://localhost:$UiPort"
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  nsExec::ExecToLog '"${SERVICE_EXE}" stop'
  Pop $0
  nsExec::ExecToLog '"${SERVICE_EXE}" uninstall'
  Pop $0
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\service"
  Delete "$INSTDIR\alfred.cmd"
  Delete "$INSTDIR\settings.properties"
  IfSilent keep
  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete everything Alfred recorded ($INSTDIR\data) and its settings (.env)?" IDNO keep
    RMDir /r "$INSTDIR\data"
    Delete "$INSTDIR\.env"
  keep:
  ReadRegStr $0 HKLM "${ENV_KEY}" "Path"
  ${WordReplace} "$0" ";$INSTDIR" "" "+" $1
  WriteRegExpandStr HKLM "${ENV_KEY}" "Path" "$1"
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
