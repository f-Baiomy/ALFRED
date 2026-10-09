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
Var StartFailed
Var OldVersion
Var Upgrading

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
  ; /DIR= (documented, and what install.ps1 and the supervisor's update pass) wins over the registry - it used to be
  ; read by nothing, so a silent install always went to the default folder.
  ClearErrors
  ${GetOptions} $R0 "/DIR=" $1
  ${IfNot} ${Errors}
  ${AndIf} $1 != ""
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
  ; A whole number from 1 to 65535, or the page stays open. A typo used to be refused only later, by "alfred config
  ; set", silently - and the last page still showed the typo as the UI address.
  IntOp $0 $UiPort + 0
  ${If} "$0" != "$UiPort"
  ${OrIf} $0 < 1
  ${OrIf} $0 > 65535
    MessageBox MB_ICONEXCLAMATION "The port must be a number from 1 to 65535."
    Abort
  ${EndIf}
FunctionEnd

; A failed or interrupted upgrade puts the previous program files back and starts the service again, so an
; existing install keeps working (spec edge case: nothing is left half-installed). The old runtime\ and app\ are
; kept as *.previous until the new ones are in place, like the Linux installer does.
Function .onInstFailed
  ${If} $Upgrading == "1"
    RMDir /r "$INSTDIR\runtime"
    RMDir /r "$INSTDIR\app"
    Rename "$INSTDIR\runtime.previous" "$INSTDIR\runtime"
    Rename "$INSTDIR\app.previous" "$INSTDIR\app"
    ${If} ${FileExists} "${SERVICE_EXE}"
      nsExec::ExecToLog '"${SERVICE_EXE}" start'
      Pop $0
    ${EndIf}
    DetailPrint "Setup failed - the previous install ($OldVersion) was put back."
  ${EndIf}
FunctionEnd

; Stops the processes that run a program from the old runtime\ or app\ (make_way.py says why), with the old python.
Function MakeWay
  ${If} ${FileExists} "$INSTDIR\runtime\python\python.exe"
    InitPluginsDir
    File "/oname=$PLUGINSDIR\make_way.py" "make_way.py"
    nsExec::ExecToLog '"$INSTDIR\runtime\python\python.exe" "$PLUGINSDIR\make_way.py" "$INSTDIR"'
    Pop $0
  ${EndIf}
FunctionEnd

; One folder moved aside and the other stayed (a file in it is in use): the moved one comes back, so the install
; stays whole whether the move is tried again or given up.
Function PutBackInUse
  ${If} ${FileExists} "$INSTDIR\runtime.previous\*.*"
  ${AndIfNot} ${FileExists} "$INSTDIR\runtime\*.*"
    Rename "$INSTDIR\runtime.previous" "$INSTDIR\runtime"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\app.previous\*.*"
  ${AndIfNot} ${FileExists} "$INSTDIR\app\*.*"
    Rename "$INSTDIR\app.previous" "$INSTDIR\app"
  ${EndIf}
FunctionEnd

; An upgrade whose new version installed but did not start or answer ($1 = why): the previous program files come
; back and start again, so an update never leaves a server down. data\updates\failed-start.txt (the version, then the
; reason) is how the supervisor that starts next - the previous version's - learns why, and shows the update as
; FAILED with that reason instead of "up to date". Exit code 7. Settings and recorded data were never touched.
Function RollBackFailedStart
  DetailPrint "Alfred ${VERSION} did not start ($1) - putting $OldVersion back"
  nsExec::ExecToLog '"${SERVICE_EXE}" stop'
  Pop $0
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\app"
  Rename "$INSTDIR\runtime.previous" "$INSTDIR\runtime"
  Rename "$INSTDIR\app.previous" "$INSTDIR\app"
  CreateDirectory "$INSTDIR\data\updates"
  FileOpen $9 "$INSTDIR\data\updates\failed-start.txt" w
  FileWrite $9 "${VERSION}$\r$\n$1$\r$\n"
  FileClose $9
  nsExec::ExecToLog '"${SERVICE_EXE}" start'
  Pop $0
  StrCpy $Upgrading "0"   ; nothing kept aside any more: the copy-dropping step below must not run
  DetailPrint "Alfred $OldVersion was put back and started again."
  IfSilent +2
    MessageBox MB_ICONEXCLAMATION "Alfred ${VERSION} was installed but did not start:$\r$\n$1$\r$\n$\r$\nAlfred $OldVersion was put back and runs again."
  SetErrorLevel 7
FunctionEnd

; "1" when the text is a version NUMBER (1.2.3, from a git tag), "0" for anything else - a bare commit hash from
; `git describe --always` on an untagged checkout (49c0c7b8-dirty). Only numbers can be ordered: VersionCompare read
; "49c0c7b8" as 49 and "f9a2d152" as 0 and refused a newer build as a downgrade.
Function IsVersionNumber
  Exch $0
  Push $1
  Push $2
  StrCpy $1 $0 1
  IntOp $2 $1 + 0
  ${If} "$2" != "$1"
    StrCpy $0 "0"
  ${Else}
    ClearErrors
    ${WordFind} "$0" "." "E+1{" $2
    ${If} ${Errors}
      StrCpy $0 "0"
    ${Else}
      StrCpy $0 "1"
    ${EndIf}
  ${EndIf}
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

Section "Alfred" SecMain
  SetShellVarContext all
  StrCpy $Upgrading "0"
  StrCpy $OldVersion ""
  ; ---- upgrade check ------------------------------------------------------------------------------------------------
  ${If} ${FileExists} "$INSTDIR\app\VERSION"
    FileOpen $0 "$INSTDIR\app\VERSION" r
    FileRead $0 $1
    FileClose $0
    ${TrimNewLines} $1 $1
    StrCpy $OldVersion $1
    ${If} $1 != "${VERSION}"
      ; The downgrade check needs two version numbers; a commit hash on either side cannot be ordered.
      Push "$1"
      Call IsVersionNumber
      Pop $3
      Push "${VERSION}"
      Call IsVersionNumber
      Pop $4
      ${If} $3 == "1"
      ${AndIf} $4 == "1"
        ${VersionCompare} "$1" "${VERSION}" $2
        ${If} $2 == "1"
        ${AndIf} $AllowDowngrade != "1"
          IfSilent +2
            MessageBox MB_ICONSTOP "Installed version $1 is newer than ${VERSION}. Run with /ALLOWDOWNGRADE to install it anyway."
          SetErrorLevel 6
          Quit
        ${EndIf}
      ${EndIf}
      DetailPrint "Upgrading $1 -> ${VERSION} (settings and recorded data are kept)"
    ${Else}
      DetailPrint "Alfred ${VERSION} is already installed - reinstalling the program files (settings and data are kept)"
    ${EndIf}
    ${If} ${FileExists} "${SERVICE_EXE}"
      nsExec::ExecToLog '"${SERVICE_EXE}" stop'
      Pop $0
    ${EndIf}
    ; Whatever still runs the old install's programs outside the service (attach-cli as the app's owner, its working
    ; directory in app\ - a folder some process works in cannot be moved; an old alfred window) is stopped first.
    Call MakeWay
    RMDir /r "$INSTDIR\runtime.previous"
    RMDir /r "$INSTDIR\app.previous"
    ; A file in use keeps a folder where it is: the service still stopping, or an alfred window (the panel, `alfred
    ; logs -f`) running on runtime\python. Windows started from alfred.cmd let go by themselves once the installer
    ; runs (alfred.py HANDED_OFF), so the move is tried again for 30 s before giving up.
    StrCpy $R5 0
    ${Do}
      Rename "$INSTDIR\runtime" "$INSTDIR\runtime.previous"
      Rename "$INSTDIR\app" "$INSTDIR\app.previous"
      ${IfNot} ${FileExists} "$INSTDIR\runtime\*.*"
      ${AndIfNot} ${FileExists} "$INSTDIR\app\*.*"
        ${Break}
      ${EndIf}
      Call PutBackInUse
      IntOp $R5 $R5 + 1
      ${If} $R5 == 5
        Call MakeWay ; something started meanwhile
      ${EndIf}
      ${If} $R5 >= 15
        ; Given up: the previous install is whole again and runs - an update never leaves Alfred stopped.
        ${If} ${FileExists} "${SERVICE_EXE}"
          nsExec::ExecToLog '"${SERVICE_EXE}" start'
          Pop $0
        ${EndIf}
        CreateDirectory "$INSTDIR\data\updates"
        FileOpen $9 "$INSTDIR\data\updates\failed-start.txt" w
        FileWrite $9 "${VERSION}$\r$\nits program folders were in use - a program works in a folder inside $INSTDIR\app or $INSTDIR\runtime (a terminal or an editor opened there). Close it and update again.$\r$\nnot-installed$\r$\n"
        FileClose $9
        DetailPrint "Program files in use - Alfred $OldVersion was started again."
        IfSilent +2
          MessageBox MB_ICONSTOP "The current install is in use: close any terminal or editor opened in a folder inside $INSTDIR\app or $INSTDIR\runtime, then run setup again.$\r$\n$\r$\nAlfred $OldVersion was started again."
        SetErrorLevel 1
        Abort "Program files in use"
      ${EndIf}
      Sleep 2000
    ${Loop}
    StrCpy $Upgrading "1"
  ${EndIf}

  ; ---- program files: everything in the stage; .env and data\ are never part of it ---------------------------------
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"
  CreateDirectory "$INSTDIR\data\log"
  DetailPrint "Program files in $INSTDIR"

  ; ---- settings: .env created once, by the Java settings engine -----------------------------------------------------
  ; Every step from here checks its result and says what failed. The first Windows builds popped the exit codes and
  ; went on, so a failed .env still ended with "installed and started" although nothing could ever start.
  ${IfNot} ${FileExists} "$INSTDIR\.env"
    nsExec::ExecToStack '"$INSTDIR\runtime\python\python.exe" "$INSTDIR\app\launcher\alfred.py" _init-env'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      DetailPrint "FAILED to create $INSTDIR\.env: $1"
      IfSilent +2
        MessageBox MB_ICONSTOP "Setup could not create the settings file $INSTDIR\.env:$\r$\n$\r$\n$1"
      SetErrorLevel 1
      Abort "Could not create $INSTDIR\.env"
    ${EndIf}
  ${EndIf}
  ${If} $UiPort == ""
    StrCpy $UiPort "3000"
  ${EndIf}
  ${If} $UiPort != "3000"
    nsExec::ExecToStack '"$INSTDIR\runtime\python\python.exe" "$INSTDIR\app\launcher\alfred.py" config set ALFRED_UI_PORT $UiPort'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      DetailPrint "UI port $UiPort was refused: $1"
      IfSilent +2
        MessageBox MB_ICONEXCLAMATION "The UI port $UiPort was refused:$\r$\n$1$\r$\nAlfred keeps port 3000. Change it later, from an Administrator prompt: alfred config set ALFRED_UI_PORT <port>"
      StrCpy $UiPort "3000"
    ${EndIf}
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
  ${If} $0 != "0"
    DetailPrint "Warning: could not restrict $INSTDIR\data to Administrators and the service (icacls exit $0)"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\.env"
    nsExec::ExecToLog 'icacls "$INSTDIR\.env" /inheritance:r /grant:r *S-1-5-18:F /grant:r *S-1-5-32-544:F'
    Pop $0
    ${If} $0 != "0"
      DetailPrint "Warning: could not restrict $INSTDIR\.env to Administrators and the service (icacls exit $0)"
    ${EndIf}
  ${EndIf}

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
  StrCpy $StartFailed "0"
  nsExec::ExecToStack '"${SERVICE_EXE}" install'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    ; An upgrade finds the service already installed; anything else is a real failure.
    nsExec::ExecToStack 'sc query alfred'
    Pop $2
    Pop $3
    ${If} $2 != "0"
      DetailPrint "FAILED to install the service: $1"
      StrCpy $StartFailed "1"
    ${EndIf}
  ${EndIf}
  ${If} $StartFailed == "0"
    nsExec::ExecToStack '"${SERVICE_EXE}" start'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      DetailPrint "FAILED to start the service: $1"
      StrCpy $StartFailed "1"
    ${EndIf}
  ${EndIf}
  ${If} $StartFailed == "0"
    DetailPrint "Service $\"alfred$\" installed and started (starts at boot)"
    ; Started is not answering: wait for /health like the Linux installer, so "installed" means it works.
    DetailPrint "Waiting for Alfred to answer..."
    nsExec::ExecToStack '"$INSTDIR\runtime\python\python.exe" "$INSTDIR\app\launcher\alfred.py" _wait-health'
    Pop $0
    Pop $1
    ${TrimNewLines} $1 $1
    ${If} $0 == "0"
      DetailPrint "$1"
    ${ElseIf} $Upgrading == "1"
      ; An upgrade that installed but does not answer is undone: the previous version comes back (exit code 7).
      Call RollBackFailedStart
    ${Else}
      DetailPrint "Alfred did not answer within 60 s. Logs: $INSTDIR\data\log (from an Administrator prompt: alfred logs supervisor)"
      IfSilent +2
        MessageBox MB_ICONEXCLAMATION "Alfred was installed and its service started, but it did not answer within 60 s.$\r$\nFrom an Administrator prompt: alfred status, alfred logs supervisor"
      SetErrorLevel 1
    ${EndIf}
  ${ElseIf} $Upgrading == "1"
    StrCpy $1 "its service did not start: $1"
    Call RollBackFailedStart
  ${Else}
    DetailPrint "Logs: $INSTDIR\data\log (alfred-service.err.log, supervisor.log) - readable from an Administrator prompt."
    IfSilent +2
      MessageBox MB_ICONEXCLAMATION "Alfred was installed but its service did not start.$\r$\nOpen an Administrator prompt and run: alfred start$\r$\nLogs: $INSTDIR\data\log"
    SetErrorLevel 1
  ${EndIf}

  ; ---- the new install is in place: drop the kept copy, record the upgrade in the settings history ------------------
  ${If} $Upgrading == "1"
    StrCpy $Upgrading "0"
    RMDir /r "$INSTDIR\runtime.previous"
    RMDir /r "$INSTDIR\app.previous"
    ${If} $OldVersion != "${VERSION}"
      nsExec::ExecToStack '"$INSTDIR\runtime\python\python.exe" "$INSTDIR\app\launcher\alfred.py" _record-upgrade "$OldVersion" "${VERSION}"'
      Pop $0
      Pop $1
      ${If} $0 != "0"
        DetailPrint "(the upgrade could not be recorded in the settings history - Alfred works regardless: $1)"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; ---- uninstaller ---------------------------------------------------------------------------------------------------
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "Alfred"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
  DetailPrint "Next, from an Administrator prompt: 'alfred status', 'alfred jvms', 'alfred attach <pid>'. UI: http://localhost:$UiPort"
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
  RMDir /r "$INSTDIR\agents" ; agent copies given to apps (a running app keeps its open copy)
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
