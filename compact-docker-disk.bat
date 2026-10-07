@echo off
rem Gives the space freed inside Docker back to Windows. Docker Desktop's virtual disk (docker_data.vhdx) only grows by
rem itself; after `docker system prune` the freed gigabytes stay inside it until it is compacted. Windows Home has no
rem Optimize-VHD, so this uses diskpart. Right-click > Run as administrator. Docker Desktop must be closed first
rem (right-click the whale in the tray > Quit Docker Desktop); every WSL distro is stopped by this too.
setlocal
set "VHDX=%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx"
net session >nul 2>&1 || (echo Run this as administrator: right-click the file ^> Run as administrator. & pause & exit /b 1)
if not exist "%VHDX%" (echo Docker disk not found at "%VHDX%". & pause & exit /b 1)
for %%F in ("%VHDX%") do echo Docker disk before: %%~zF bytes
echo Stopping WSL (Docker Desktop must already be closed)...
wsl --shutdown
timeout /t 5 /nobreak >nul
set "SCRIPT=%TEMP%\compact-docker-disk.diskpart.txt"
> "%SCRIPT%" echo select vdisk file="%VHDX%"
>> "%SCRIPT%" echo attach vdisk readonly
>> "%SCRIPT%" echo compact vdisk
>> "%SCRIPT%" echo detach vdisk
>> "%SCRIPT%" echo exit
diskpart /s "%SCRIPT%"
del "%SCRIPT%" >nul 2>&1
for %%F in ("%VHDX%") do echo Docker disk after:  %%~zF bytes
echo Done. Start Docker Desktop again.
pause
