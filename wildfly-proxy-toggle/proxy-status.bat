@echo off
setlocal

rem proxy-status.bat - reports whether the proxy is currently on/off for the detected WildFly
rem instance, by reading its system properties directly over the Attach API connection (no
rem agent jar needed for this - see WildFlyProxyController.java's "status" branch).
rem
rem A JDK 8 install is needed (tools.jar, for the Attach API) - auto-detected via FindJdk8.java
rem regardless of what JAVA_HOME currently points at, unless JDK8_HOME is set explicitly.

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
set "TOOLS_JAR=%JDK8_HOME%\lib\tools.jar"

"%JAVAC%" -cp "%TOOLS_JAR%" -d "%DIR%out" "%DIR%WildFlyProxyController.java"
if errorlevel 1 exit /b 1

"%JAVA%" -cp "%DIR%out;%TOOLS_JAR%" WildFlyProxyController status
exit /b %ERRORLEVEL%
