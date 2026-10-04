@echo off
setlocal

rem db-capture-off.bat <project> - switches database capture off for <project>. The agent stays loaded but
rem records nothing for that project; a WildFly restart removes it completely (an agent cannot be unloaded).

if "%~1"=="" (
    echo usage: db-capture-off.bat ^<project^>
    exit /b 1
)
if "%ALFRED_URL%"=="" set "ALFRED_URL=http://localhost:3000"
curl -fsS -X PUT -H "Content-Type: application/json" -d "{\"enabled\":false}" "%ALFRED_URL%/db-capture/projects/%~1/enabled" >nul
if errorlevel 1 exit /b 1
echo Database capture OFF for %~1.
