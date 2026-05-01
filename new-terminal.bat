@echo off
REM Opens a fresh Claude Code CLI terminal at the specified repo or the project root.
REM
REM   Usage: new-terminal.bat                           (ACC root, blank session)
REM   Usage: new-terminal.bat /design                   (ACC root, /design pre-seeded)
REM   Usage: new-terminal.bat blt-e2e                   (blt-e2e root, blank session)
REM   Usage: new-terminal.bat blt-e2e /design           (blt-e2e root, /design pre-seeded)
REM
REM Uses Shell.Application COM object to spawn a visible desktop window even from
REM within VSCode's non-interactive subprocess context.
REM
REM REPOS_PARENT is read from .env in the repo root. Update it there if your repos
REM live somewhere other than C:\Git-Repositories.
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "CLAUDE=%APPDATA%\npm\claude"
set "REPOS_PARENT=C:\Git-Repositories"

REM Read REPOS_PARENT from .env if present
for /f "usebackq tokens=1,* delims==" %%a in ("%ROOT%\.env") do (
    if "%%a"=="REPOS_PARENT" set "REPOS_PARENT=%%b"
)

REM Resolve target directory and optional pre-seed command
set "TARGET=%ROOT%"
set "PRESEED="

if "%~1"=="" goto :run

REM If first arg starts with /, it's a slash command targeting ACC root
set "FIRST=%~1"
if "%FIRST:~0,1%"=="/" (
    set "PRESEED=%~1"
    goto :run
)

REM Otherwise, first arg is a repo name
set "TARGET=%REPOS_PARENT%\%~1"
if not "%~2"=="" set "PRESEED=%~2"

:run
if "%PRESEED%"=="" (
    powershell -Command "$sh = New-Object -ComObject Shell.Application; $sh.ShellExecute('cmd.exe', '/k cd /d \"%TARGET%\" && \"%CLAUDE%\"', '%TARGET%', 'open', 1)"
) else (
    powershell -Command "$sh = New-Object -ComObject Shell.Application; $sh.ShellExecute('cmd.exe', '/k cd /d \"%TARGET%\" && \"%CLAUDE%\" ""%PRESEED%""', '%TARGET%', 'open', 1)"
)
endlocal
