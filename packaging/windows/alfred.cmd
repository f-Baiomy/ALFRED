@echo off
rem The "alfred" command of a native install: runs the bundled Python on app\launcher\alfred.py.
setlocal
set "ALFRED_HOME=%~dp0"
if "%ALFRED_HOME:~-1%"=="\" set "ALFRED_HOME=%ALFRED_HOME:~0,-1%"
rem An update must move runtime\ aside, and this window's python.exe runs from it. Once the installer runs, alfred.py
rem writes a PowerShell script here that follows the rest and exits; the script runs after python.exe let go.
set "ALFRED_FOLLOW_SCRIPT=%TEMP%\alfred-follow-%RANDOM%%RANDOM%.ps1"
rem One block: cmd parses it whole before running it. The installer replaces this file meanwhile, and cmd would go on
rem reading the new file from the old offset; nothing after the block is ever read. %ERRORLEVEL% in a block is
rem expanded when the block is parsed: `call` expands it again when the line runs.
(
  "%ALFRED_HOME%\runtime\python\python.exe" "%ALFRED_HOME%\app\launcher\alfred.py" %*
  if exist "%ALFRED_FOLLOW_SCRIPT%" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ALFRED_FOLLOW_SCRIPT%"
  call exit /b %%ERRORLEVEL%%
)
