@echo off
setlocal

rem proxy-on.bat - thin wrapper: compiles (if needed) and runs WildFlyProxyController.java,
rem which does the actual work - detects the running WildFly instance via the Java Attach API
rem (prompting if more than one is found), then loads WildFlyProxyAgent into it to set
rem https.proxyHost/https.proxyPort system properties. No restart, no standalone.xml touched
rem even transiently, no launch-config change. Run proxy-off.bat to reverse. See
rem WildFlyProxyController.java/WildFlyProxyAgent.java and README.md for details.
rem
rem A JDK 8 install is needed (tools.jar, for the Attach API) - auto-detected via FindJdk8.java
rem regardless of what JAVA_HOME currently points at (a machine's default JAVA_HOME is commonly
rem a newer JDK for everything else - confirmed live), unless JDK8_HOME is set explicitly.

set "DIR=%~dp0"
set "BOOT_JAVA=java"
set "BOOT_JAVAC=javac"
if not "%JAVA_HOME%"=="" (
    set "BOOT_JAVA=%JAVA_HOME%\bin\java.exe"
    set "BOOT_JAVAC=%JAVA_HOME%\bin\javac.exe"
)

if not exist "%DIR%out" mkdir "%DIR%out"
"%BOOT_JAVAC%" -d "%DIR%out" "%DIR%FindJdk8.java"
if errorlevel 1 exit /b 1

rem for /f with backticks mangles quoted paths containing spaces (e.g. "C:\Program Files\...") -
rem a redirect-to-temp-file avoids that class of quoting bug entirely.
set "TMP_JDK8=%TEMP%\alfred-jdk8-%RANDOM%.txt"
"%BOOT_JAVA%" -cp "%DIR%out" FindJdk8 > "%TMP_JDK8%"
set /p JDK8_HOME=<"%TMP_JDK8%"
del "%TMP_JDK8%" >nul 2>&1

if "%JDK8_HOME%"=="" (
    echo JAVA_HOME is not set, or is not a JDK 8 install ^(needed for tools.jar / the
    echo Attach API^). Set JDK8_HOME explicitly, e.g.:
    echo   set JDK8_HOME=C:\Program Files\Java\jdk1.8.0_XXX
    exit /b 1
)
echo Using JDK 8 at %JDK8_HOME%

set "JAVAC=%JDK8_HOME%\bin\javac.exe"
set "JAVA=%JDK8_HOME%\bin\java.exe"
set "JAR=%JDK8_HOME%\bin\jar.exe"
set "TOOLS_JAR=%JDK8_HOME%\lib\tools.jar"

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
