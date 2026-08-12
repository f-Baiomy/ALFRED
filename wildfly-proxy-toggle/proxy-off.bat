@echo off
setlocal

rem proxy-off.bat - reverses proxy-on.bat: compiles (if needed) and runs WildflyProxyToggle.java
rem to remove the https.proxyHost/https.proxyPort system properties from the detected WildFly
rem instance. Safe to run even if the proxy was never turned on.

set "DIR=%~dp0"
set "JAVAC=javac"
set "JAVA=java"
if not "%JAVA_HOME%"=="" set "JAVAC=%JAVA_HOME%\bin\javac.exe"
if not "%JAVA_HOME%"=="" set "JAVA=%JAVA_HOME%\bin\java.exe"

if not exist "%DIR%out" mkdir "%DIR%out"
"%JAVAC%" -d "%DIR%out" "%DIR%WildflyProxyToggle.java"
if errorlevel 1 exit /b 1

"%JAVA%" -cp "%DIR%out" WildflyProxyToggle off
exit /b %ERRORLEVEL%
