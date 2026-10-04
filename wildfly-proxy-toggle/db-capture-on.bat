@echo off
setlocal

rem db-capture-on.bat <project> - loads Alfred's database capture agent (db-agent\) into the running
rem WildFly (same detection as proxy-on.bat), then switches capture on for <project> - the same switch as
rem the diamond in Live Calls' Sources bar. No restart. See db-capture-on.sh for the details.
rem Env: ALFRED_URL (default http://localhost:3000), WILDFLY_PID, JDK8_HOME.

if "%~1"=="" (
    echo usage: db-capture-on.bat ^<project^>
    exit /b 1
)
set "PROJECT=%~1"
set "DIR=%~dp0"
for %%I in ("%DIR%..") do set "ROOT=%%~fI"
if "%ALFRED_URL%"=="" set "ALFRED_URL=http://localhost:3000"
set "JAR=%ROOT%\db-agent\target\alfred-db-agent.jar"

if not exist "%JAR%" (
    echo Building the database capture agent...
    where mvn >nul 2>&1
    if errorlevel 1 (
        docker run --rm -v "%ROOT%:/repo" -v alfred-m2:/root/.m2 -w /repo/db-agent maven:3.9-eclipse-temurin-8 mvn -B -q -DskipTests package
    ) else (
        pushd "%ROOT%\db-agent" && call mvn -B -q -DskipTests package & popd
    )
    if not exist "%JAR%" exit /b 1
)

if not exist "%DIR%out" mkdir "%DIR%out"
set "COPY=%DIR%out\alfred-db-agent-%RANDOM%.jar"
copy /y "%JAR%" "%COPY%" >nul

set "BOOT_JAVA=java"
set "BOOT_JAVAC=javac"
if not "%JAVA_HOME%"=="" (
    set "BOOT_JAVA=%JAVA_HOME%\bin\java.exe"
    set "BOOT_JAVAC=%JAVA_HOME%\bin\javac.exe"
)
"%BOOT_JAVAC%" -d "%DIR%out" "%DIR%FindJdk8.java"
if errorlevel 1 exit /b 1
if "%JDK8_HOME%"=="" (
    call "%BOOT_JAVA%" -cp "%DIR%out" FindJdk8 > "%TEMP%\alfred-jdk8.txt"
    set /p JDK8_HOME=<"%TEMP%\alfred-jdk8.txt"
    del "%TEMP%\alfred-jdk8.txt" >nul 2>&1
)
if "%JDK8_HOME%"=="" (
    echo A JDK 8 install is needed for the Attach API ^(tools.jar^). Set JDK8_HOME explicitly.
    exit /b 1
)
set "TOOLS_JAR=%JDK8_HOME%\lib\tools.jar"
"%JDK8_HOME%\bin\javac.exe" -cp "%TOOLS_JAR%" -d "%DIR%out" "%DIR%WildFlyProxyController.java"
if errorlevel 1 exit /b 1
"%JDK8_HOME%\bin\java.exe" -cp "%DIR%out;%TOOLS_JAR%" WildFlyProxyController load-agent "%COPY%" "alfredUrl=%ALFRED_URL%;project=%PROJECT%;secretFile=%ROOT%\.env"
if errorlevel 1 exit /b 1

echo Switching database capture on for %PROJECT%...
curl -fsS -X PUT -H "Content-Type: application/json" -d "{\"enabled\":true}" "%ALFRED_URL%/db-capture/projects/%PROJECT%/enabled" >nul
if errorlevel 1 (
    echo The agent is loaded, but capture could not be switched on ^(is inbound logging on for %PROJECT%?^). Use the switch in Live Calls.
    exit /b 0
)
echo Database capture ON for %PROJECT%.
