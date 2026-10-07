@echo off
rem The "alfred" command of a native install: runs the bundled Python on app\launcher\alfred.py.
setlocal
set "ALFRED_HOME=%~dp0"
if "%ALFRED_HOME:~-1%"=="\" set "ALFRED_HOME=%ALFRED_HOME:~0,-1%"
"%ALFRED_HOME%\runtime\python\python.exe" "%ALFRED_HOME%\app\launcher\alfred.py" %*
exit /b %ERRORLEVEL%
