@echo off
cd /d "%~dp0"
title AgentCodeGUI - BUILD INSTALLER
echo.
echo   Building the one-click installer (NSIS).
echo   This produces dist\AgentCodeGUI-Setup-^<version^>.exe
echo   For quick code preview, dev.bat is much faster.
echo.
call npm run package
if errorlevel 1 (
  echo   [build FAILED] check the errors above.
  pause
  exit /b 1
)
echo.
echo   Done. Installer is in dist\  (the code-sign warnings are harmless).
start "" explorer "%~dp0dist"
pause
