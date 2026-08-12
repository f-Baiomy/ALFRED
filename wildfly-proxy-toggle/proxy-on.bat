@echo off
setlocal

rem proxy-on.bat - thin wrapper: compiles (if needed) and runs WildflyProxyToggle.java, which
rem does the actual work - detects the running WildFly instance (prompting if more than one is
rem found), and adds https.proxyHost/https.proxyPort system properties to it via the management
rem CLI. No restart, no standalone.xml hand-edit, no launch-config change. Run proxy-off.bat to
rem reverse. See WildflyProxyToggle.java and README.md for details and optional env var overrides.

set "DIR=%~dp0"
set "JAVAC=javac"
set "JAVA=java"
if not "%JAVA_HOME%"=="" set "JAVAC=%JAVA_HOME%\bin\javac.exe"
if not "%JAVA_HOME%"=="" set "JAVA=%JAVA_HOME%\bin\java.exe"

if not exist "%DIR%out" mkdir "%DIR%out"
"%JAVAC%" -d "%DIR%out" "%DIR%WildflyProxyToggle.java"
if errorlevel 1 exit /b 1

"%JAVA%" -cp "%DIR%out" WildflyProxyToggle on
exit /b %ERRORLEVEL%
