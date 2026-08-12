@echo off
setlocal enabledelayedexpansion

rem proxy-status.bat - reports whether the proxy is currently on/off for the detected WildFly
rem instance, by reading its system properties directly over the Attach API connection (no
rem agent jar needed for this - see WildFlyProxyController.java's "status" branch).
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
set "TOOLS_JAR=%JAVA_HOME%\lib\tools.jar"

if not exist "%TOOLS_JAR%" (
    echo Could not find %TOOLS_JAR% - is JAVA_HOME a JDK 8 install, not a JRE?
    exit /b 1
)

if not exist "%DIR%out" mkdir "%DIR%out"
"%JAVAC%" -cp "%TOOLS_JAR%" -d "%DIR%out" "%DIR%WildFlyProxyController.java"
if errorlevel 1 exit /b 1

"%JAVA%" -cp "%DIR%out;%TOOLS_JAR%" WildFlyProxyController status
exit /b %ERRORLEVEL%
