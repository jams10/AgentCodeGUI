@echo off
cd /d "%~dp0"
title AgentCodeGUI - INSTALL
echo.
echo   Installing dependencies (npm install)...
echo.
call npm install
echo.
if errorlevel 1 (
  echo   [install FAILED] check the errors above.
) else (
  echo   [install OK] now run dev.bat
)
pause
