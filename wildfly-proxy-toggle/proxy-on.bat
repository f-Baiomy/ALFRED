@echo off
setlocal enabledelayedexpansion

rem proxy-on.bat - thin wrapper: compiles (if needed) and runs WildFlyProxyController.java,
rem which does the actual work - detects the running WildFly instance via the Java Attach API
rem (prompting if more than one is found), then loads WildFlyProxyAgent into it to set
rem https.proxyHost/https.proxyPort system properties. No restart, no standalone.xml touched
rem even transiently, no launch-config change. Run proxy-off.bat to reverse. See
rem WildFlyProxyController.java/WildFlyProxyAgent.java and README.md for details.
rem
rem Requires JAVA_HOME set to a JDK 8 install (needs tools.jar for the Attach API).

if "%JAVA_HOME%"=="" (
    echo Set JAVA_HOME to a JDK 8 install first ^(needed for tools.jar / the Attach API^), e.g.:
    echo   set JAVA_HOME=C:\Program Files\Java\jdk1.8.0_XXX
    exit /b 1
)

set "DIR=%~dp0"
set "JAVAC=%JAVA_HOME%\bin\javac.exe"
set "JAVA=%JAVA_HOME%\bin\java.exe"
set "JAR=%JAVA_HOME%\bin\jar.exe"
set "TOOLS_JAR=%JAVA_HOME%\lib\tools.jar"

if not exist "%TOOLS_JAR%" (
    echo Could not find %TOOLS_JAR% - is JAVA_HOME a JDK 8 install, not a JRE?
    exit /b 1
)

if not exist "%DIR%out" mkdir "%DIR%out"
if not exist "%DIR%agent-out" mkdir "%DIR%agent-out"

"%JAVAC%" -d "%DIR%agent-out" "%DIR%WildFlyProxyAgent.java"
if errorlevel 1 exit /b 1

rem Once loaded into a target JVM, this jar's file handle stays open (and locked, on Windows)
rem for that JVM's remaining lifetime - a fixed filename would fail to rebuild on a later run
rem against the same still-running instance. %RANDOM% sidesteps that entirely.
set "AGENT_JAR=%DIR%out\wildfly-agent-%RANDOM%.jar"
"%JAR%" cfm "%AGENT_JAR%" "%DIR%MANIFEST.MF" -C "%DIR%agent-out" .
if errorlevel 1 exit /b 1

"%JAVAC%" -cp "%TOOLS_JAR%" -d "%DIR%out" "%DIR%WildFlyProxyController.java"
if errorlevel 1 exit /b 1

"%JAVA%" -cp "%DIR%out;%TOOLS_JAR%" -DAGENT_JAR="%AGENT_JAR%" WildFlyProxyController on
exit /b %ERRORLEVEL%
