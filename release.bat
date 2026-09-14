@echo off
cd /d "%~dp0"
title AgentCodeGUI - RELEASE (publish to GitHub)
echo.
echo   Publishes a new release to GitHub Releases so installed apps auto-update.
echo.
echo   Before running:
echo     1) Bump "version" in package.json (e.g. 1.0.0 -^> 1.0.1)
echo     2) Set a GitHub token with repo write access:
echo            set GH_TOKEN=ghp_xxxxxxxxxxxxxxxx
echo.
if "%GH_TOKEN%"=="" (
  echo   [stop] GH_TOKEN is not set. Run:  set GH_TOKEN=your_token   then retry.
  pause
  exit /b 1
)
call npm run release
if errorlevel 1 (
  echo   [release FAILED] check the errors above.
  pause
  exit /b 1
)
echo.
echo   Done. A draft/published release with the installer + latest.yml is on GitHub.
echo   Installed apps will detect it on next launch and update automatically.
pause
