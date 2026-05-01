@echo off
setlocal

:: QA Command Center — New Machine Setup
:: Creates directory junctions so Claude Code picks up skills/commands
:: from this repo instead of the default ~/.claude/ locations.
::
:: Run once after cloning, from the repo root.

set REPO=%~dp0
set CLAUDE=%USERPROFILE%\.claude

echo Setting up Claude Code junctions from qa-command-center...
echo.

:: --- commands ---
if exist "%CLAUDE%\commands" (
    echo Removing existing %CLAUDE%\commands ...
    rmdir /s /q "%CLAUDE%\commands"
)
mklink /J "%CLAUDE%\commands" "%REPO%.claude\commands"
if %errorlevel% neq 0 (
    echo ERROR: Failed to create junction for commands. Try running as Administrator.
    exit /b 1
)
echo [OK] commands linked

:: --- skills ---
if exist "%CLAUDE%\skills" (
    echo Removing existing %CLAUDE%\skills ...
    rmdir /s /q "%CLAUDE%\skills"
)
mklink /J "%CLAUDE%\skills" "%REPO%.claude\skills"
if %errorlevel% neq 0 (
    echo ERROR: Failed to create junction for skills.
    exit /b 1
)
echo [OK] skills linked

echo.
echo Done! All Claude skills are now served from qa-command-center.
endlocal
