@echo off
rem native.bat ACTION [FLAGS...] - called by the scripts in this folder when Alfred is installed as a program
rem (specs/012-server-program): "alfred attach/detach" on the one running WildFly (or WILDFLY_PID), with the bundled
rem JDK - no JDK 8 or tools.jar needed. ACTION "status" lists the Java apps and what Alfred does in each.
setlocal
set "ALFRED=%ALFRED_HOME%\alfred.cmd"
if "%~1"=="status" (
    call "%ALFRED%" jvms
    exit /b %ERRORLEVEL%
)
set "PID=%WILDFLY_PID%"
set "MANY="
if not defined PID (
    for /f "tokens=1,2" %%a in ('call "%ALFRED%" jvms') do (
        if "%%b"=="WildFly" (
            if defined PID (set "MANY=1") else (set "PID=%%a")
        )
    )
)
if defined MANY (
    echo More than one WildFly is running - set WILDFLY_PID to pick one:
    call "%ALFRED%" jvms
    exit /b 1
)
if not defined PID (
    echo No running WildFly found. 'alfred jvms' lists every Java app; 'alfred %~1 PID' works on any of them.
    exit /b 1
)
call "%ALFRED%" %1 %PID% %2 %3 %4 %5 %6 %7 %8
exit /b %ERRORLEVEL%
