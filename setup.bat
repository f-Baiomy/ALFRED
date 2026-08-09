@echo off
setlocal enabledelayedexpansion

rem setup.bat - installs Docker Desktop and Python on Windows if either is missing,
rem so "python start.py" has what it needs. Safe to re-run - already-installed
rem prerequisites are skipped.
rem
rem Run from an Administrator terminal (installing Docker Desktop needs it):
rem   setup.bat

net session >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo This needs Administrator rights to install software.
    echo Right-click setup.bat and choose "Run as administrator".
    exit /b 1
)

echo === Alfred setup: checking prerequisites ===

where winget >nul 2>nul
set WINGET_OK=%ERRORLEVEL%

where docker >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [ok] Docker already installed
) else (
    echo Docker not found - installing Docker Desktop...
    if !WINGET_OK! neq 0 (
        echo winget not found. Install Docker Desktop manually: https://www.docker.com/products/docker-desktop
        exit /b 1
    )
    winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
    if !ERRORLEVEL! neq 0 (
        echo Docker Desktop install failed - install it manually: https://www.docker.com/products/docker-desktop
        exit /b 1
    )
    echo [installed] Docker Desktop - start it once from the Start menu before running start.py,
    echo             a reboot may be required first.
)

where python >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [ok] Python already installed
) else (
    echo Python not found - installing...
    if !WINGET_OK! neq 0 (
        echo winget not found. Install Python manually: https://www.python.org/downloads/
        exit /b 1
    )
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    if !ERRORLEVEL! neq 0 (
        echo Python install failed - install it manually: https://www.python.org/downloads/
        exit /b 1
    )
    echo [installed] Python
    echo Close and reopen your terminal so PATH picks up the new install.
)

echo.
echo === Done. Next: run "python start.py" from an Administrator terminal. ===
