@echo off
cd /d "%~dp0"

for /f "delims=" %%v in (.nvmrc) do set NODE_VER=%%v

if not defined NVM_HOME (
    echo ERROR: NVM_HOME is not set. Install NVM for Windows first.
    pause
    exit /b 1
)

set NODE_EXE=%NVM_HOME%\v%NODE_VER%\node.exe

if not exist "%NODE_EXE%" (
    echo ERROR: Node v%NODE_VER% not found via NVM. Run: nvm install %NODE_VER%
    pause
    exit /b 1
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 "') do taskkill /f /pid %%a >nul 2>&1
PowerShell -WindowStyle Hidden -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
timeout /t 3 /nobreak >nul
start "" http://localhost:3000
exit
